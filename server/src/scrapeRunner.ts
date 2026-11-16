import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import {
  createScraper,
  SCRAPERS,
  type CompanyTypes,
  type ScraperCredentials,
  type ScraperScrapingResult,
} from "israeli-bank-scrapers";
import { ApiError, type ApiErrorCode } from "./errors.js";
import { exportBrowserSession, restoreBrowserSession, type BrowserSession } from "./browserSession.js";
import { NAVIGATION_TIMEOUT_MS, SCRAPE_TIMEOUT_MS } from "./syncSupport.js";

export type ScrapedAccount = NonNullable<ScraperScrapingResult["accounts"]>[number];

const LOGIN_PROBE_INTERVAL_MS = 2_000;

/**
 * Where persistent Chromium profiles live, if set (SCRAPER_USER_DATA_DIR). Each
 * saved connection gets its own profile directory, so everything the bank
 * stores on the device — cookies, localStorage, IndexedDB, the lot — survives
 * between runs on this machine. On Cloud Run the filesystem is ephemeral, so
 * there the encrypted session stored with the connection does that job (see
 * browserSession.ts); both can be active at once.
 */
const PROFILE_ROOT = process.env.SCRAPER_USER_DATA_DIR || undefined;

export interface RunScrapeOptions {
  headless?: boolean;
  /** Device state from the previous scrape of this connection, restored before login. */
  session?: BrowserSession;
  /**
   * Receives the device state at the end of the run — whenever the login got
   * through, even if the scrape then failed — so the trust the bank just
   * granted this device isn't lost with the browser.
   */
  onSession?: (session: BrowserSession) => void | Promise<void>;
  /**
   * Called once, the moment the bank accepts the login (the scraper's
   * LOGIN_SUCCESS), while the same browser goes on to fetch the transactions.
   * Not awaited: it must not slow the scrape, and its failure doesn't fail it.
   */
  onLoginSuccess?: () => void | Promise<void>;
  /** Names the on-disk profile under SCRAPER_USER_DATA_DIR; without it the browser is profile-less. */
  profileId?: string;
}

/** The profile directory for `profileId`, if persistent profiles are enabled. */
export function profileDir(profileId: string | undefined): string | undefined {
  if (!PROFILE_ROOT || !profileId) return undefined;
  // Profile ids are connection UUIDs; keep the path safe regardless.
  return join(PROFILE_ROOT, profileId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

// Required to run Chromium as root inside a container without a user namespace
// sandbox; --disable-dev-shm-usage avoids crashes from Docker's tiny /dev/shm.
// The rest present the browser as an ordinary Israeli desktop Chrome (Hebrew
// UI, no automation banner / navigator.webdriver) — bank sites treat an
// obviously automated browser as suspicious — and trim background work that
// only costs memory in a 1–2 GiB Cloud Run instance.
export const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--lang=he-IL",
  "--disable-blink-features=AutomationControlled",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--no-first-run",
  "--mute-audio",
];

const TIMEZONE = "Asia/Jerusalem";
const ACCEPT_LANGUAGE = "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7";
/** How long browser.close() may take before the Chromium process is killed. */
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
/** A retry is only attempted if at least this much of the scrape budget is left. */
const MIN_RETRY_BUDGET_MS = 90_000;
const RETRY_BACKOFF_MS = 3_000;

/** The headless user agent with its "HeadlessChrome" token, which many sites block outright, made ordinary. */
export function desktopUserAgent(ua: string) {
  return ua.replace(/HeadlessChrome/g, "Chrome");
}

/**
 * Network-level failures (connection reset, DNS hiccup, the page's target
 * crashing) that say nothing about the login itself: worth one more try.
 * Navigation timeouts are not retried — they already used up most of the
 * budget — and neither is anything the bank answered (wrong password, OTP, …).
 */
export function isTransientScrapeError(err: unknown) {
  if (!(err instanceof ApiError) || err.code !== "BANK_ERROR") return false;
  const message = String(err.details?.internalMessage ?? "");
  return /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|Target closed|Session closed|Protocol error|detached Frame|Execution context was destroyed/i.test(
    message,
  );
}

/**
 * Closes the browser, and kills its process if it doesn't close in time —
 * a hung Chromium left behind would hold hundreds of MB until the instance
 * is recycled.
 */
export async function closeBrowser(browser: Browser, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS) {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    browser.close().then(
      () => true,
      () => false,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (closed) return;
  const proc = browser.process();
  if (proc && proc.exitCode === null && !proc.killed) {
    console.warn(JSON.stringify({ event: "browser_force_killed", pid: proc.pid }));
    proc.kill("SIGKILL");
  }
}

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
  // after NAVIGATION_TIMEOUT_MS and reports GENERIC; its own invalid-password check (same
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
 * Runs one scrape in a headless browser. Credentials only live in this call's
 * memory and are handed straight to the scraper. The browser is closed
 * whether the scrape succeeds, fails or times out; what survives it is the
 * device state the bank set (see browserSession.ts), handed to `onSession`,
 * and — with SCRAPER_USER_DATA_DIR — the on-disk profile.
 */
export async function runScrape(
  companyId: CompanyTypes,
  credentials: Record<string, string>,
  startDate: Date,
  options: RunScrapeOptions = {},
): Promise<ScrapedAccount[]> {
  // One budget for the whole run, retry included.
  const deadline = Date.now() + SCRAPE_TIMEOUT_MS;
  const state = { loggedIn: false };
  try {
    return await runScrapeOnce(companyId, credentials, startDate, options, deadline, state);
  } catch (err) {
    // Only before the login got through: once it has, a second login is a
    // second bank session for the same user, and the fetch failure is better
    // reported (the connection keeps its verified login either way).
    const retry = !state.loggedIn && isTransientScrapeError(err) && deadline - Date.now() >= MIN_RETRY_BUDGET_MS;
    if (!retry) throw err;
    console.warn(
      JSON.stringify({ event: "scrape_retry", companyId, reason: String((err as ApiError).details?.internalMessage ?? "") }),
    );
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    return runScrapeOnce(companyId, credentials, startDate, options, deadline, state);
  }
}

async function runScrapeOnce(
  companyId: CompanyTypes,
  credentials: Record<string, string>,
  startDate: Date,
  { headless = true, session, onSession, onLoginSuccess, profileId }: RunScrapeOptions,
  deadline: number,
  state: { loggedIn: boolean },
): Promise<ScrapedAccount[]> {
  const userDataDir = profileDir(profileId);
  if (userDataDir) mkdirSync(userDataDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless,
    args: BROWSER_ARGS,
    // Drops the "controlled by automated software" switch (and with it navigator.webdriver).
    ignoreDefaultArgs: ["--enable-automation"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    userDataDir,
    env: { ...process.env, TZ: TIMEZONE },
  });
  let timer: NodeJS.Timeout | undefined;
  let probeTimer: NodeJS.Timeout | undefined;
  let loggedIn = false;
  const userAgent = desktopUserAgent(await browser.userAgent().catch(() => ""));

  try {
    let page: Page | undefined;
    const scraper = createScraper({
      companyId,
      startDate,
      combineInstallments: false,
      browser,
      skipCloseBrowser: true,
      // Per page navigation / wait. Bank SPAs (Cal in particular) can take over
      // 60s to settle when reached from a cloud IP; SCRAPE_TIMEOUT_MS caps the whole run.
      defaultTimeout: NAVIGATION_TIMEOUT_MS,
      preparePage: async (p) => {
        page = p;
        // An Israeli desktop browser: Hebrew, Jerusalem time. A scraper that
        // sets its own user agent (Cal) overrides this one at login.
        await Promise.all([
          userAgent && p.setUserAgent(userAgent),
          p.setExtraHTTPHeaders({ "Accept-Language": ACCEPT_LANGUAGE }),
          p.emulateTimezone(TIMEZONE),
        ]).catch((err) => console.warn(JSON.stringify({ event: "page_locale_failed", companyId, error: String(err) })));
        // Before the first navigation, so the bank's login page already sees
        // the device it trusted last time.
        if (session) {
          await restoreBrowserSession(browser, p, session).catch((err) => {
            console.warn(JSON.stringify({ event: "session_restore_failed", companyId, error: String(err) }));
          });
        }
      },
    });
    scraper.onProgress((_, { type }) => {
      if (type !== "LOGIN_SUCCESS" || loggedIn) return;
      loggedIn = true;
      state.loggedIn = true;
      Promise.resolve()
        .then(onLoginSuccess)
        .catch((err) => console.warn(JSON.stringify({ event: "login_success_hook_failed", companyId, error: String(err) })));
    });

    const scrape = scraper.scrape(credentials as ScraperCredentials);
    // If the timeout or a login probe wins, closing the browser makes `scrape`
    // reject later; swallow that so it doesn't surface as an unhandled rejection.
    scrape.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ApiError("BANK_TIMEOUT", { scraperErrorType: "TIMEOUT" })),
        Math.max(0, deadline - Date.now()),
      );
    });

    const racers: Promise<unknown>[] = [scrape, timeout];
    const probe = LOGIN_ERROR_PROBES[companyId];
    if (probe) {
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
    // Capture the device state while the browser is still open. A login that
    // got through is worth keeping even when the fetch after it failed.
    if (loggedIn && onSession) {
      try {
        const exported = await exportBrowserSession(browser);
        if (exported) await onSession(exported);
      } catch (err) {
        console.warn(JSON.stringify({ event: "session_export_failed", companyId, error: String(err) }));
      }
    }
    await closeBrowser(browser);
  }
}
