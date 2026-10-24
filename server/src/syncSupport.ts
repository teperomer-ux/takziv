import type { Response } from "express";
import { ApiError, sendError, type ApiErrorCode } from "./errors.js";
import type { SyncOutcome } from "./scraperService.js";

export const MAX_CONCURRENT_SCRAPES = Math.max(1, Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2));

/** A saved connection is due for a scheduled sync once its last sync is this old. */
export const SYNC_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Per-instance cap on simultaneous Chromium instances (~300-500MB RAM each).
// Parallel logins to the same bank account — which can get it locked — are
// prevented across instances by the Firestore lease on the connection
// (connectionRepository.acquireSyncLease), not here.
let activeBrowsers = 0;

/** Returns an idempotent release function, or null if this instance is at capacity. */
export function acquireBrowserSlot(limit = MAX_CONCURRENT_SCRAPES): (() => void) | null {
  if (activeBrowsers >= limit) return null;
  activeBrowsers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeBrowsers--;
  };
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
  return {
    savedCount: saved,
    savedExpenseCount: savedExpenses,
    savedIncomeCount: savedIncomes,
    duplicateCount: result.expenses.length + result.incomes.length - saved,
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
