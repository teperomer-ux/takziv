import type { Response } from "express";
import { ApiError, sendError, type ApiErrorCode } from "./errors.js";
import type { SyncOutcome } from "./scraperService.js";

const MAX_CONCURRENT_SCRAPES = Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2);

// Per-instance guards shared by every route that logs in to a bank: one sync
// per user (repeated parallel logins can get a bank account locked) and a
// global cap on simultaneous Chromium instances.
const activeUsers = new Set<string>();

/** Returns a release function, or the error code to send if the user can't sync now. */
export function acquireSyncSlot(uid: string): (() => void) | ApiErrorCode {
  if (activeUsers.has(uid)) return "SCRAPE_IN_PROGRESS";
  if (activeUsers.size >= MAX_CONCURRENT_SCRAPES) return "SERVER_BUSY";
  activeUsers.add(uid);
  return () => activeUsers.delete(uid);
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
