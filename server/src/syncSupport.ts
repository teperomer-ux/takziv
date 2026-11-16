import type { Response } from "express";
import { ApiError, sendError, type ApiErrorCode } from "./errors.js";
import type { SyncOutcome } from "./scraperService.js";

export const MAX_CONCURRENT_SCRAPES = Math.max(1, Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2));

/**
 * How long one scrape (login + fetch) may take. SCRAPE_TIMEOUT_MS raises it,
 * e.g. for a visible-browser run where the user completes a one-time code by
 * hand; never below 30s.
 */
export const SCRAPE_TIMEOUT_MS = Math.max(30_000, Number(process.env.SCRAPE_TIMEOUT_MS) || 180_000);

/** How long a single page navigation or wait inside a scrape may take (Puppeteer's default timeout). */
export const NAVIGATION_TIMEOUT_MS = 100_000;

/** A saved connection is due for a scheduled sync once its last sync is this old. */
export const SYNC_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long a request may wait in this instance's queue for a browser slot
 * before it is turned away with SERVER_BUSY. Waiting + SCRAPE_TIMEOUT_MS +
 * the Firestore writes must stay under the HTTP request timeout (index.ts)
 * and Cloud Run's --timeout (300s).
 */
export const QUEUE_WAIT_MS = Math.max(0, Number(process.env.QUEUE_WAIT_MS) || 60_000);

// Per-instance cap on simultaneous Chromium instances (~300-500MB RAM each).
// Parallel logins to the same bank account — which can get it locked — are
// prevented across instances by the Firestore lease on the connection
// (connectionRepository.acquireSyncLease), not here.
let activeBrowsers = 0;
/** Requests waiting for a slot, first come first served. */
const waiters: { limit: number; grant: (release: () => void) => void }[] = [];

function makeRelease() {
  activeBrowsers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeBrowsers--;
    handOff();
  };
}

/** Gives freed slots to the oldest waiters. */
function handOff() {
  while (waiters.length && activeBrowsers < waiters[0].limit) {
    waiters.shift()!.grant(makeRelease());
  }
}

/** Returns an idempotent release function, or null if this instance is at capacity (or others are queued first). */
export function acquireBrowserSlot(limit = MAX_CONCURRENT_SCRAPES): (() => void) | null {
  if (activeBrowsers >= limit || waiters.length) return null;
  return makeRelease();
}

/**
 * Waits up to `maxWaitMs` for a browser slot, in arrival order, instead of
 * failing at once when the instance is busy: with MAX_CONCURRENT_SCRAPES=1 a
 * second account connected right after the first would otherwise get
 * SERVER_BUSY while the first one's fetch is still running. Resolves to the
 * release function, or null once the wait times out.
 */
export function waitForBrowserSlot(
  maxWaitMs = QUEUE_WAIT_MS,
  limit = MAX_CONCURRENT_SCRAPES,
): Promise<(() => void) | null> {
  const now = acquireBrowserSlot(limit);
  if (now || maxWaitMs <= 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const waiter = {
      limit,
      grant: (release: () => void) => {
        clearTimeout(timer);
        resolve(release);
      },
    };
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx !== -1) waiters.splice(idx, 1);
      resolve(null);
    }, maxWaitMs);
    waiters.push(waiter);
  });
}

/** Browsers running and requests queued on this instance (for logs). */
export function browserSlotStats() {
  return { active: activeBrowsers, queued: waiters.length };
}

/** True if a connection never synced, or last synced more than `staleAfterMs` ago. */
export function isSyncDue(lastSyncAt: Date | null, now = new Date(), staleAfterMs = SYNC_STALE_AFTER_MS) {
  return !lastSyncAt || now.getTime() - lastSyncAt.getTime() > staleAfterMs;
}

/** Bank-side failures a retry can't fix: the user has to act, and retrying risks a lockout. */
export const REQUIRES_ACTION: ReadonlySet<ApiErrorCode> = new Set([
  "BANK_INVALID_CREDENTIALS",
  "BANK_OTP_REQUIRED",
  "BANK_CHANGE_PASSWORD",
  "BANK_ACCOUNT_BLOCKED",
]);

export function syncLogger(fields: Record<string, unknown>) {
  const startedAt = Date.now();
  return (outcome: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ event: "scrape", ...fields, outcome, ms: Date.now() - startedAt, ...extra }));
}

/** The JSON body every sync endpoint returns on success. */
export function syncResponseBody(result: SyncOutcome) {
  const savedExpenses = result.expensesSaved.inserted;
  const savedIncomes = result.incomesSaved.inserted;
  const saved = savedExpenses + savedIncomes;
  const both = (k: "duplicateById" | "duplicateByContent" | "dismissed") =>
    result.expensesSaved[k] + result.incomesSaved[k];
  return {
    savedCount: saved,
    savedExpenseCount: savedExpenses,
    savedIncomeCount: savedIncomes,
    duplicateCount: result.expenses.length + result.incomes.length - saved,
    /** Fetched again and already in the app (same id, or matched to an uploaded row). Never overwritten. */
    alreadySavedCount: both("duplicateById") + both("duplicateByContent"),
    /** Deleted by the user earlier, so not brought back. */
    dismissedCount: both("dismissed"),
    skippedPendingCount: result.skippedPending,
    skippedCardPaymentCount: result.skippedCardPayments,
    accounts: result.accounts,
  };
}

/** Logs an error with its internal details and sends only the public ones. */
export function sendSyncError(res: Response, err: unknown, log: ReturnType<typeof syncLogger>) {
  const apiErr = err instanceof ApiError ? err : new ApiError("INTERNAL_ERROR");
  const { internalMessage, ...publicDetails } = apiErr.details ?? {};
  log("error", {
    code: apiErr.code,
    ...publicDetails,
    internalMessage: internalMessage ?? (err instanceof ApiError ? undefined : String(err)),
  });
  sendError(res, apiErr.code, Object.keys(publicDetails).length ? publicDetails : undefined);
  return apiErr.code;
}
