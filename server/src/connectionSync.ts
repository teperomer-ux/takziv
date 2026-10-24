import type { CompanyTypes } from "israeli-bank-scrapers";
import { ApiError } from "./errors.js";
import { syncProvider, type SyncOutcome } from "./scraperService.js";
import {
  ConnectionNotFoundError,
  acquireSyncLease,
  findConnectionId,
  getConnection,
  loadCredentials,
  releaseSyncLease,
  updateConnectionStatus,
  type BankConnection,
} from "./connectionRepository.js";
import { REQUIRES_ACTION, acquireBrowserSlot } from "./syncSupport.js";

/**
 * Syncing a saved connection, shared by POST /api/connections/:id/sync and
 * the scheduled job (syncJob.ts). Every failure is thrown as an ApiError; the
 * connection's status and lastErrorCode are already updated by then.
 */

export interface SyncResult {
  /** The connection as stored after the sync (status, lastSyncAt, …). */
  connection: BankConnection;
  outcome: SyncOutcome;
}

/** Overlap re-fetched on every sync so pending rows that settled since are picked up. */
const OVERLAP_DAYS = 7;
const MAX_LOOKBACK_DAYS = 365;

/** From the 1st of last month, the same default the sync form uses. */
export function defaultStartDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

function syncStartDate(lastSyncAt: Date | null) {
  if (!lastSyncAt) return defaultStartDate();
  const from = new Date(lastSyncAt.getTime() - OVERLAP_DAYS * 86_400_000);
  const floor = new Date(Date.now() - MAX_LOOKBACK_DAYS * 86_400_000);
  return from < floor ? floor : from;
}

function logLeaseError(event: string, err: unknown) {
  console.error(JSON.stringify({ event, error: String(err) }));
}

/** Runs `fn` while holding the connection's lease; throws SCRAPE_IN_PROGRESS if another sync holds it. */
async function withLease<T>(uid: string, connectionId: string, fn: (connection: BankConnection) => Promise<T>) {
  let lease;
  try {
    lease = await acquireSyncLease(uid, connectionId);
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) throw new ApiError("CONNECTION_NOT_FOUND");
    throw err;
  }
  if (!lease.acquired) throw new ApiError("SCRAPE_IN_PROGRESS");

  try {
    return await fn(lease.connection);
  } finally {
    await releaseSyncLease(uid, connectionId, lease.token).catch((e) => logLeaseError("lease_release_failed", e));
  }
}

/** Runs `fn` in one of this instance's browser slots; throws SERVER_BUSY if none is free. */
async function withBrowserSlot<T>(fn: () => Promise<T>) {
  const release = acquireBrowserSlot();
  if (!release) throw new ApiError("SERVER_BUSY");
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Syncs a saved connection with its stored credentials: lease → status check
 * → decrypt → scrape and save → status update → release.
 *
 * Never retries a login the bank already rejected (status needs_attention) —
 * that's how bank accounts get locked — and flags the connection when the
 * bank rejects it now.
 */
export async function syncSavedConnection(uid: string, connectionId: string): Promise<SyncResult> {
  return withBrowserSlot(() =>
    // The lease is checked first, before any status read, so the status can't
    // change between the check and the login: only lease holders write it.
    withLease(uid, connectionId, async (connection) => {
      if (connection.status === "needs_attention") {
        throw new ApiError("CONNECTION_NEEDS_ATTENTION", { lastErrorCode: connection.lastErrorCode });
      }

      try {
        let stored;
        try {
          // loadCredentials also checks the secret belongs to `uid`.
          stored = await loadCredentials(uid, connectionId);
        } catch (err) {
          // Key missing/changed: the saved login is unusable until re-entered.
          await updateConnectionStatus(uid, connectionId, {
            status: "needs_attention",
            lastErrorCode: "CREDENTIALS_UNREADABLE",
          });
          throw new ApiError("CONNECTION_NEEDS_ATTENTION", {
            lastErrorCode: "CREDENTIALS_UNREADABLE",
            internalMessage: String(err),
          });
        }

        const outcome = await syncProvider(uid, {
          provider: stored.companyId,
          credentials: stored.credentials,
          startDate: syncStartDate(connection.lastSyncAt),
        });
        await updateConnectionStatus(uid, connectionId, { status: "active", lastErrorCode: null, synced: true });
        return { connection: await getConnection(uid, connectionId), outcome };
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : new ApiError("INTERNAL_ERROR", { internalMessage: String(err) });
        if (apiErr.code !== "CONNECTION_NEEDS_ATTENTION") {
          await updateConnectionStatus(uid, connectionId, {
            ...(REQUIRES_ACTION.has(apiErr.code) && { status: "needs_attention" }),
            lastErrorCode: apiErr.code,
          }).catch((e) => console.error(JSON.stringify({ event: "status_update_failed", error: String(e) })));
        }
        throw apiErr;
      }
    }),
  );
}

/**
 * For syncs with credentials typed in just now (connect, one-off): holds the
 * lease of the user's saved connection to the same provider, if there is one,
 * so a scheduled sync can't log in to that account at the same moment.
 * Unlike syncSavedConnection this doesn't refuse needs_attention — re-entering
 * the login is how the user fixes it.
 */
export async function withProviderSlot<T>(uid: string, companyId: CompanyTypes, fn: () => Promise<T>) {
  return withBrowserSlot(async () => {
    const connectionId = await findConnectionId(uid, companyId);
    return connectionId ? withLease(uid, connectionId, () => fn()) : fn();
  });
}
