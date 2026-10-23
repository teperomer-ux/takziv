import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { createScraper, SCRAPERS, } from "israeli-bank-scrapers";
import { ApiError } from "./errors.js";
/**
 * Local troubleshooting only (SCRAPER_DEBUG=true in server/.env): opens a
 * visible Chromium window and saves a screenshot of every open tab when a
 * scrape fails. Never enable in production — screenshots can show account data.
 */
const DEBUG = process.env.SCRAPER_DEBUG === "true";
const DEBUG_SCREENSHOT_DIR = path.resolve("debug-screenshots");
export const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS ?? 120_000);
// Required to run Chromium as root inside a container without a user namespace
// sandbox; --disable-dev-shm-usage avoids crashes from Docker's tiny /dev/shm.
const BROWSER_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
];
const ERROR_CODE_BY_SCRAPER_ERROR = {
    INVALID_PASSWORD: "BANK_INVALID_CREDENTIALS",
    TWO_FACTOR_RETRIEVER_MISSING: "BANK_OTP_REQUIRED",
    CHANGE_PASSWORD: "BANK_CHANGE_PASSWORD",
    ACCOUNT_BLOCKED: "BANK_ACCOUNT_BLOCKED",
    TIMEOUT: "BANK_TIMEOUT",
};
async function saveDebugScreenshots(browser, companyId) {
    try {
        await mkdir(DEBUG_SCREENSHOT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const pages = await browser.pages();
        for (const [i, page] of pages.entries()) {
            const file = path.join(DEBUG_SCREENSHOT_DIR, `${stamp}-${companyId}-tab${i}.png`);
            await page.screenshot({ path: file, fullPage: true });
            console.info(JSON.stringify({ event: "scrape_debug_screenshot", url: page.url(), file }));
        }
    }
    catch (err) {
        console.error("[scrapeRunner] debug screenshot failed:", err instanceof Error ? err.message : err);
    }
}
/** Login fields the company requires that are absent from `credentials`. */
export function missingLoginFields(companyId, credentials) {
    return SCRAPERS[companyId].loginFields.filter((field) => !credentials[field]);
}
/** Replace any credential value that appears in `text` so it is safe to log. */
export function redact(text, credentials) {
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
export async function runScrape(companyId, credentials, startDate) {
    const browser = await puppeteer.launch({
        headless: !DEBUG,
        // A real window size so sites render their desktop layout while debugging.
        defaultViewport: DEBUG ? null : undefined,
        args: BROWSER_ARGS,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    let timer;
    // Last progress step the scraper reported (LOGGING_IN, LOGIN_SUCCESS, …) —
    // tells a timeout during login apart from one while fetching transactions.
    let lastStage = "LAUNCHED";
    try {
        const scraper = createScraper({
            companyId,
            startDate,
            combineInstallments: false,
            browser,
            skipCloseBrowser: true,
            defaultTimeout: 60_000,
        });
        scraper.onProgress((_company, { type }) => {
            lastStage = type;
            if (DEBUG)
                console.info(JSON.stringify({ event: "scrape_progress", companyId, stage: type }));
        });
        const scrape = scraper.scrape(credentials);
        // If the timeout wins, closing the browser makes `scrape` reject later;
        // swallow that so it doesn't surface as an unhandled rejection.
        scrape.catch(() => { });
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new ApiError("BANK_TIMEOUT", { internalMessage: `timed out after ${SCRAPE_TIMEOUT_MS}ms` })), SCRAPE_TIMEOUT_MS);
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
    }
    catch (err) {
        const apiErr = err instanceof ApiError
            ? err
            : new ApiError("BANK_ERROR", {
                internalMessage: redact(err instanceof Error ? err.message : String(err), credentials),
            });
        if (DEBUG)
            await saveDebugScreenshots(browser, companyId);
        throw new ApiError(apiErr.code, { ...apiErr.details, stage: lastStage });
    }
    finally {
        clearTimeout(timer);
        await browser.close().catch(() => { });
    }
}
