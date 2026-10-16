import puppeteer from "puppeteer";
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

// Required to run Chromium as root inside a container without a user namespace
// sandbox; --disable-dev-shm-usage avoids crashes from Docker's tiny /dev/shm.
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

const ERROR_CODE_BY_SCRAPER_ERROR: Record<string, ApiErrorCode> = {
  INVALID_PASSWORD: "BANK_INVALID_CREDENTIALS",
  TWO_FACTOR_RETRIEVER_MISSING: "BANK_OTP_REQUIRED",
  CHANGE_PASSWORD: "BANK_CHANGE_PASSWORD",
  ACCOUNT_BLOCKED: "BANK_ACCOUNT_BLOCKED",
  TIMEOUT: "BANK_TIMEOUT",
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
): Promise<ScrapedAccount[]> {
  const browser = await puppeteer.launch({
    headless: true,
    args: BROWSER_ARGS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  let timer: NodeJS.Timeout | undefined;

  try {
    const scraper = createScraper({
      companyId,
      startDate,
      combineInstallments: false,
      browser,
      skipCloseBrowser: true,
      defaultTimeout: 60_000,
    });

    const scrape = scraper.scrape(credentials as ScraperCredentials);
    // If the timeout wins, closing the browser makes `scrape` reject later;
    // swallow that so it doesn't surface as an unhandled rejection.
    scrape.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError("BANK_TIMEOUT")), SCRAPE_TIMEOUT_MS);
    });

    const result = await Promise.race([scrape, timeout]);
    if (!result.success) {
      const code = ERROR_CODE_BY_SCRAPER_ERROR[result.errorType ?? ""] ?? "BANK_ERROR";
      throw new ApiError(code, {
        scraperErrorType: result.errorType,
        // Kept server-side for logging only; never sent to the client.
        internalMessage: redact(result.errorMessage ?? "", credentials),
      });
    }
    return result.accounts ?? [];
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError("BANK_ERROR", { internalMessage: redact(message, credentials) });
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
  }
}
