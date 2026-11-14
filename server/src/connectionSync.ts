import { randomUUID } from "node:crypto";
import type { CompanyTypes } from "israeli-bank-scrapers";
import { ApiError } from "./errors.js";
import { syncProvider, type SyncOutcome } from "./scraperService.js";
import {
  ConnectionNotFoundError,
  acquireSyncLease,
  findConnectionId,
  getConnection,
  discardUnverifiedConnection,
  loadCredentials,
  loadSession,
  releaseSyncLease,
  saveSession,
  saveVerifiedConnection,
  updateConnectionStatus,
  type BankConnection,
} from "./connectionRepository.js";
import { CredentialVaultError } from "./credentialVault.js";
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

/** defaultStartDate() as YYYY-MM-DD. */
export function defaultStartYmd() {
  const d = defaultStartDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

const israelYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);

/** A start date the user may pick: YYYY-MM-DD, not in the future, at most MAX_LOOKBACK_DAYS back. */
export function isValidStartDate(ymd: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || Number.isNaN(new Date(ymd).getTime())) return false;
  // Round-trip rejects impossible dates such as 2026-02-31.
  if (new Date(ymd).toISOString().slice(0, 10) !== ymd) return false;
  const earliest = israelYmd(new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86_400_000));
  return ymd <= israelYmd(now) && ymd >= earliest;
}

/**
 * Flagged connections whose saved login is still fine and may be retried by
 * the user without typing it again. A one-time-code prompt means the bank
 * didn't recognise the device, not that the password is wrong; retrying it
 * can't lock the account, and once the bank trusts the device again (or the
 * code requirement lapses) the sync goes through and clears the flag.
 */
const RETRY_SAFE_ATTENTION: ReadonlySet<string> = new Set(["BANK_OTP_REQUIRED"]);

/** True if a needs_attention connection can be synced again with its stored credentials. */
export function canRetryWithoutNewCredentials(c: Pick<BankConnection, "status" | "lastErrorCode">) {
  return c.status === "needs_attention" && !!c.lastErrorCode && RETRY_SAFE_ATTENTION.has(c.lastErrorCode);
}

/** True if the user moved the start date before what has been fetched so far. */
export function needsBackfill(c: Pick<BankConnection, "startDate" | "syncedFrom">) {
  return !!c.startDate && (!c.syncedFrom || c.startDate < c.syncedFrom);
}

/**
 * Where a sync of a saved connection starts:
 *  - an explicit override (POST …/sync with a startDate) wins, for that sync only;
 *  - a start date earlier than what's been fetched → backfill from it, once;
 *  - otherwise incremental: last sync minus OVERLAP_DAYS, never before the
 *    saved start date, never more than MAX_LOOKBACK_DAYS back.
 * `fetchedFrom` is set when the sync reaches back to a new earliest date.
 */
export function syncWindow(
  c: Pick<BankConnection, "startDate" | "syncedFrom" | "lastSyncAt">,
  override?: string,
  now = new Date(),
): { start: Date; fetchedFrom?: string } {
  const explicit = override ?? (needsBackfill(c) ? c.startDate! : undefined);
  if (explicit) {
    const reachesFurther = !c.syncedFrom || explicit < c.syncedFrom;
    return { start: new Date(explicit), ...(reachesFurther && { fetchedFrom: explicit }) };
  }

  let start = c.lastSyncAt ? new Date(c.lastSyncAt.getTime() - OVERLAP_DAYS * 86_400_000) : defaultStartDate();
  const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86_400_000);
  if (start < floor) start = floor;
  if (c.startDate && start < new Date(c.startDate)) start = new Date(c.startDate);
  return { start };
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
 * → decrypt → scrape and save → status update → release. `startDate`
 * overrides the window for this sync only (see syncWindow).
 *
 * Never retries a login the bank already rejected (status needs_attention
 * over the credentials themselves) — that's how bank accounts get locked —
 * and flags the connection when the bank rejects it now. A connection whose
 * first fetch didn't complete ("syncing", login already verified) is retried
 * here too; success makes it active. A connection
 * flagged only for a one-time code may be retried (see
 * canRetryWithoutNewCredentials); the scheduled job never does, as it only
 * picks active connections.
 */
export async function syncSavedConnection(
  uid: string,
  connectionId: string,
  { startDate }: { startDate?: string } = {},
): Promise<SyncResult> {
  if (startDate !== undefined && !isValidStartDate(startDate)) {
    throw new ApiError("INVALID_REQUEST", { fields: ["startDate"] });
  }
  return withBrowserSlot(() =>
    // The lease is checked first, before any status read, so the status can't
    // change between the check and the login: only lease holders write it.
    withLease(uid, connectionId, async (connection) => {
      // A leftover saved unverified by an earlier version: hidden, never logged in with.
      if (!connection.loginVerified) throw new ApiError("CONNECTION_NOT_FOUND");
      if (connection.status === "needs_attention" && !canRetryWithoutNewCredentials(connection)) {
        throw new ApiError("CONNECTION_NEEDS_ATTENTION", { lastErrorCode: connection.lastErrorCode });
      }

      try {
        let stored;
        try {
          // loadCredentials also checks the secret belongs to `uid`.
          stored = await loadCredentials(uid, connectionId);
        } catch (err) {
          // Only a record that can't be read with this key — missing, wrong
          // key, failed integrity check — makes the saved login unusable. A
          // KMS or Firestore outage is reported as such and leaves the
          // connection active: the next sync will read it fine.
          const unreadable = err instanceof CredentialVaultError || err instanceof ConnectionNotFoundError;
          if (!unreadable) {
            throw new ApiError("CREDENTIAL_STORE_UNAVAILABLE", { internalMessage: String(err) });
          }
          await updateConnectionStatus(uid, connectionId, {
            status: "needs_attention",
            lastErrorCode: "CREDENTIALS_UNREADABLE",
          });
          throw new ApiError("CONNECTION_NEEDS_ATTENTION", {
            lastErrorCode: "CREDENTIALS_UNREADABLE",
            internalMessage: String(err),
          });
        }

        const { start, fetchedFrom } = syncWindow(connection, startDate);
        const outcome = await syncProvider(uid, {
          provider: stored.companyId,
          credentials: stored.credentials,
          startDate: start,
          session: stored.session ?? undefined,
          profileId: connectionId,
          // Stored as soon as the login got through, before the result is
          // known, so a failed fetch doesn't cost the device's trust.
          onSession: (session) =>
            saveSession(uid, connectionId, session).catch((e) =>
              console.error(JSON.stringify({ event: "session_save_failed", connectionId, error: String(e) })),
            ),
        });
        await updateConnectionStatus(uid, connectionId, {
          status: "active",
          lastErrorCode: null,
          loginVerified: true,
          synced: true,
          ...(fetchedFrom && { syncedFrom: fetchedFrom }),
        });
        // Read while still holding our lease, which withLease releases before
        // the caller sees this — so the sync is no longer in progress by then.
        return { connection: { ...(await getConnection(uid, connectionId)), syncInProgress: false }, outcome };
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
 * Connects (or re-connects) a provider with credentials typed in just now, in
 * one request and one bank login:
 *
 *   1. logs in. Nothing is written before the bank accepts the login: a wrong
 *      password, OTP prompt, blocked account or login timeout leaves no trace
 *      (and leaves an existing connection's working credentials untouched).
 *   2. the moment the bank accepts it (the scraper's LOGIN_SUCCESS), stores the
 *      credentials as a verified connection, status "syncing", tagged with
 *      `attemptId` so the client's dialog can see the login went through and
 *      close while this same browser session goes on fetching.
 *   3. fetches and saves the transactions, then marks the connection active —
 *      or, if the fetch fails, records lastErrorCode ("first sync incomplete"
 *      for a new connection; an existing one stays active).
 *
 * The request stays open for the whole run: on Cloud Run the CPU is only
 * guaranteed while a request is in flight.
 */
export async function connectAndSync(
  uid: string,
  companyId: CompanyTypes,
  credentials: Record<string, string>,
  { startDate, attemptId }: { startDate: string; attemptId: string },
): Promise<SyncResult> {
  return withProviderSlot(uid, companyId, async (existingId) => {
    const existing = existingId ? await getConnection(uid, existingId) : undefined;
    // A leftover from an earlier version, saved before its login was checked.
    const reuseId = existing?.loginVerified ? existingId : undefined;
    let promotion: Promise<string> | undefined;
    let ownLease: string | undefined;
    const promote = () =>
      (promotion ??= (async () => {
        // An unverified leftover is replaced by this verified login, under its id.
        const connectionId = existingId;
        if (!connectionId) ownLease = randomUUID();
        return saveVerifiedConnection(uid, companyId, credentials, {
          connectionId,
          startDate,
          attemptId,
          leaseToken: ownLease,
        });
      })());
    const logError = (event: string) => (e: unknown) => console.error(JSON.stringify({ event, companyId, error: String(e) }));

    let connectionId: string | undefined;
    try {
      let outcome: SyncOutcome;
      try {
        outcome = await syncProvider(uid, {
          provider: companyId,
          credentials,
          startDate: new Date(startDate),
          session: reuseId ? (await loadSession(uid, reuseId)) ?? undefined : undefined,
          profileId: reuseId,
          onLoginSuccess: async () => {
            connectionId = await promote();
          },
          // Called while the browser closes, after a login that got through.
          onSession: async (session) => {
            const id = await promotion?.catch(() => undefined);
            if (id) await saveSession(uid, id, session).catch(logError("session_save_failed"));
          },
        });
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : new ApiError("INTERNAL_ERROR", { internalMessage: String(err) });
        if (!promotion) {
          // Stage 1 failed: the login never got through, so nothing is kept.
          if (existingId && !reuseId) await discardUnverifiedConnection(uid, existingId).catch(logError("discard_failed"));
          throw apiErr;
        }
        // Stage 2 failed: the login is verified and saved; the fetch didn't complete.
        connectionId = await promotion.catch((e) => {
          throw new ApiError("CREDENTIAL_STORE_UNAVAILABLE", { internalMessage: String(e) });
        });
        await updateConnectionStatus(uid, connectionId, {
          ...(existing?.lastSyncAt && { status: "active" }),
          lastErrorCode: apiErr.code,
        }).catch(logError("status_update_failed"));
        throw apiErr;
      }

      // Scrapers that never report LOGIN_SUCCESS are promoted here, once they succeed.
      try {
        connectionId = await promote();
      } catch (e) {
        throw new ApiError("CREDENTIAL_STORE_UNAVAILABLE", { internalMessage: String(e) });
      }
      const reachesFurther = !existing?.syncedFrom || startDate < existing.syncedFrom;
      await updateConnectionStatus(uid, connectionId, {
        status: "active",
        lastErrorCode: null,
        loginVerified: true,
        synced: true,
        ...(reachesFurther && { syncedFrom: startDate }),
      });
      return { connection: { ...(await getConnection(uid, connectionId)), syncInProgress: false }, outcome };
    } finally {
      if (ownLease && connectionId) await releaseSyncLease(uid, connectionId, ownLease).catch(logError("lease_release_failed"));
    }
  });
}

/**
 * For syncs with credentials typed in just now (one-off): holds the
 * lease of the user's saved connection to the same provider, if there is one,
 * so a scheduled sync can't log in to that account at the same moment.
 * Unlike syncSavedConnection this doesn't refuse needs_attention — re-entering
 * the login is how the user fixes it. `fn` gets that connection's id so it
 * can reuse the device state saved with it.
 */
export async function withProviderSlot<T>(
  uid: string,
  companyId: CompanyTypes,
  fn: (connectionId: string | undefined) => Promise<T>,
) {
  return withBrowserSlot(async () => {
    const connectionId = await findConnectionId(uid, companyId);
    return connectionId ? withLease(uid, connectionId, () => fn(connectionId)) : fn(undefined);
  });
}
