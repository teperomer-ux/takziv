import puppeteer, { type Page } from "puppeteer";
import {
  createScraper,
  SCRAPERS,
  type CompanyTypes,
  type ScraperCredentials,
  type ScraperScrapingResult,
} from "israeli-bank-scrapers";
import { ApiError, type ApiErrorCode } from "./errors.js";

export type ScrapedAccount = NonNullable<ScraperScrapingResult["accounts"]>[number];

const SCRAPE_TIMEOUT_MS = 120_000;
const LOGIN_PROBE_INTERVAL_MS = 2_000;

// Required to run Chromium as root inside a container without a user namespace
// sandbox; --disable-dev-shm-usage avoids crashes from Docker's tiny /dev/shm.
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/** ScraperErrorTypes (israeli-bank-scrapers doesn't export the enum) → API error code. */
const ERROR_CODE_BY_SCRAPER_ERROR: Record<string, ApiErrorCode> = {
  INVALID_PASSWORD: "BANK_INVALID_CREDENTIALS",
  TWO_FACTOR_RETRIEVER_MISSING: "BANK_OTP_REQUIRED",
  CHANGE_PASSWORD: "BANK_CHANGE_PASSWORD",
  ACCOUNT_BLOCKED: "BANK_ACCOUNT_BLOCKED",
  TIMEOUT: "BANK_TIMEOUT",
};

/**
 * The API error for a failed scrape. `scraperErrorType` is passed through to
 * the client so it can show the exact reason; `internalMessage` stays in the
 * server log. Scrapers report Puppeteer's own timeouts ("Navigation timeout
 * of 60000 ms exceeded") as GENERIC, so those count as timeouts too.
 */
export function scraperError(errorType: string | undefined, message: string, credentials: Record<string, string>) {
  const type = errorType || "GENERIC";
  const code =
    ERROR_CODE_BY_SCRAPER_ERROR[type] ??
    (type === "GENERIC" && /timeout/i.test(message) ? "BANK_TIMEOUT" : "BANK_ERROR");
  return new ApiError(code, { scraperErrorType: type, internalMessage: redact(message, credentials) });
}

/**
 * Login failures some bank pages show without the scraper noticing. Each probe
 * looks at the live page during the scrape and returns a ScraperErrorTypes
 * value once the bank has displayed a definite failure.
 */
const LOGIN_ERROR_PROBES: Partial<Record<CompanyTypes, (page: Page) => Promise<string | null>>> = {
  // Cal shows "wrong username or password" inside its login iframe without
  // navigating. The scraper's postAction waits for a navigation, times out
  // after 60s and reports GENERIC; its own invalid-password check (same
  // frame, selector and text as here) never runs.
  visaCal: async (page) => {
    for (const frame of page.frames()) {
      if (!frame.url().includes("connect")) continue;
      const text = await frame
        .$eval("div.general-error > div", (el) => (el as HTMLElement).innerText)
        .catch(() => null);
      if (text?.trim() === "שם המשתמש או הסיסמה שהוזנו שגויים") return "INVALID_PASSWORD";
    }
    return null;
  },
};

/** Login fields the company requires that are absent from `credentials`. */
export function missingLoginFields(companyId: CompanyTypes, credentials: Record<string, string>) {
  return SCRAPERS[companyId].loginFields.filter((field) => !credentials[field]);
}

/** Replace any credential value that appears in `text` so it is safe to log. */
export function redact(text: string, credentials: Record<string, string>) {
  return Object.values(credentials)
    .filter((v) => v.length >= 4)
    .reduce((out, v) => out.split(v).join("[REDACTED]"), text);
}

/**
 * Runs one scrape in a fresh headless browser. Credentials only live in this
 * call's memory and are handed straight to the scraper; the browser (and with
 * it every cookie/session the bank set) is closed whether the scrape
 * succeeds, fails or times out.
 */
export async function runScrape(
  companyId: CompanyTypes,
  credentials: Record<string, string>,
  startDate: Date,
  { headless = true }: { headless?: boolean } = {},
): Promise<ScrapedAccount[]> {
  const browser = await puppeteer.launch({
    headless,
    args: BROWSER_ARGS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  let timer: NodeJS.Timeout | undefined;
  let probeTimer: NodeJS.Timeout | undefined;

  try {
    let page: Page | undefined;
    const scraper = createScraper({
      companyId,
      startDate,
      combineInstallments: false,
      browser,
      skipCloseBrowser: true,
      defaultTimeout: 60_000,
      preparePage: async (p) => {
        page = p;
      },
    });

    const scrape = scraper.scrape(credentials as ScraperCredentials);
    // If the timeout or a login probe wins, closing the browser makes `scrape`
    // reject later; swallow that so it doesn't surface as an unhandled rejection.
    scrape.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError("BANK_TIMEOUT", { scraperErrorType: "TIMEOUT" })), SCRAPE_TIMEOUT_MS);
    });

    const racers: Promise<unknown>[] = [scrape, timeout];
    const probe = LOGIN_ERROR_PROBES[companyId];
    if (probe) {
      let loggedIn = false;
      scraper.onProgress((_, { type }) => {
        if (type === "LOGIN_SUCCESS") loggedIn = true;
      });
      racers.push(
        new Promise<never>((_, reject) => {
          let busy = false;
          probeTimer = setInterval(async () => {
            if (loggedIn) return clearInterval(probeTimer);
            if (!page || busy) return;
            busy = true;
            try {
              const errorType = await probe(page);
              if (errorType) reject(scraperError(errorType, "Login error shown on the bank page", credentials));
            } catch {
              // Frames detach while the bank navigates; try again next tick.
            } finally {
              busy = false;
            }
          }, LOGIN_PROBE_INTERVAL_MS);
        }),
      );
    }

    const result = (await Promise.race(racers)) as Awaited<typeof scrape>;
    if (!result.success) throw scraperError(result.errorType, result.errorMessage ?? "", credentials);
    return result.accounts ?? [];
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw scraperError("GENERIC", err instanceof Error ? err.message : String(err), credentials);
  } finally {
    clearTimeout(timer);
    clearInterval(probeTimer);
    await browser.close().catch(() => {});
  }
}
