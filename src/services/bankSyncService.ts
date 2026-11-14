import { Timestamp, collection, onSnapshot, type DocumentData } from "firebase/firestore";
import { auth, db, getUidOrNull } from "../lib/firebase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export type BankSyncErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "MISSING_CREDENTIAL_FIELDS"
  | "SCRAPE_IN_PROGRESS"
  | "SERVER_BUSY"
  | "BANK_INVALID_CREDENTIALS"
  | "BANK_OTP_REQUIRED"
  | "BANK_CHANGE_PASSWORD"
  | "BANK_ACCOUNT_BLOCKED"
  | "BANK_TIMEOUT"
  | "BANK_ERROR"
  | "SAVE_FAILED"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_NEEDS_ATTENTION"
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export interface BankSyncResult {
  savedCount: number;
  savedExpenseCount: number;
  /** Bank credits saved to users/{uid}/incomeTransactions. */
  savedIncomeCount: number;
  duplicateCount: number;
  skippedPendingCount: number;
  /** Bank debits that were credit-card bill payments (covered by the card's own sync). */
  skippedCardPaymentCount: number;
  accounts: { accountNumber: string; balance: number | null }[];
}

/** A saved connection as the server reports it — never includes credentials. */
export interface BankConnection {
  id: string;
  companyId: string;
  /**
   * "syncing": the bank accepted the login (connections only exist after that,
   * see connectAccount); the first fetch is running or didn't complete.
   * "needs_attention": the bank rejected the saved login / wants OTP or a password change.
   */
  status: "syncing" | "active" | "needs_attention";
  /** A login to this connection is running right now (on any device / the scheduled job). */
  syncInProgress: boolean;
  /**
   * The bank accepted these credentials. Always true for connections the
   * user sees: unverified leftovers from older versions are filtered out.
   */
  loginVerified: boolean;
  /** The connectAccount attempt that last stored these credentials (live list only). */
  connectAttemptId?: string | null;
  /** e.g. "•••789" */
  maskedLogin: string;
  lastErrorCode: string | null;
  /** ISO timestamp */
  lastSyncAt: string | null;
  /** YYYY-MM-DD transactions are fetched from; null for connections saved before this existed. */
  startDate: string | null;
  /** YYYY-MM-DD back to which transactions have actually been fetched. */
  syncedFrom: string | null;
  /**
   * ISO timestamp of the last time the server captured the bank's trusted-device
   * state (cookies) for this connection; null until the first successful login.
   */
  sessionSavedAt: string | null;
}

/** The start date was moved before what's been fetched; the next sync backfills to it. */
export function needsBackfill(c: BankConnection): boolean {
  return !!c.startDate && (!c.syncedFrom || c.startDate < c.syncedFrom);
}

/**
 * What the user sees as the connection's state:
 *  - syncing:         just connected (the bank accepted the login); fetching transactions in the background
 *  - sync_incomplete: just connected (the bank accepted the login), but the first fetch didn't
 *                     finish (timeout, bank error, tab closed); sync to retry, no need to re-enter the login
 *  - active:          healthy
 *  - unstable:        healthy, but the last sync failed on the bank's side (timeout, …); retried automatically
 *  - session_expired: the bank stopped trusting the device and asked for a one-time code;
 *                     the saved login is fine and can be retried without re-entering it
 *  - reauth_required: the bank rejected the saved login (wrong/expired password, blocked, unreadable)
 *
 * `running`: a sync of this connection is in flight (from this tab, or per the server's lease).
 */
export type ConnectionState =
  | "syncing"
  | "sync_incomplete"
  | "active"
  | "unstable"
  | "session_expired"
  | "reauth_required";

export function connectionState(
  c: Pick<BankConnection, "status" | "lastErrorCode" | "loginVerified">,
  running = false,
): ConnectionState {
  if (c.status === "needs_attention") return c.lastErrorCode === "BANK_OTP_REQUIRED" ? "session_expired" : "reauth_required";
  if (c.status === "syncing") return running ? "syncing" : "sync_incomplete";
  return c.lastErrorCode ? "unstable" : "active";
}

/** Mirrors the server: a session_expired connection syncs again with its stored login. */
export function canRetryWithoutNewCredentials(c: Pick<BankConnection, "status" | "lastErrorCode" | "loginVerified">): boolean {
  return connectionState(c) === "session_expired";
}

export interface ConnectionSyncResult extends BankSyncResult {
  connection: BankConnection;
}

export class BankSyncError extends Error {
  constructor(
    public readonly code: BankSyncErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Authenticated call to the sync server; throws BankSyncError with the server error code. */
export async function apiRequest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new BankSyncError("UNAUTHENTICATED", "Not signed in");
  const token = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload !== undefined && { "Content-Type": "application/json" }),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch {
    throw new BankSyncError("NETWORK_ERROR", "Could not reach the sync server");
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const err = body?.error;
    throw new BankSyncError(err?.code ?? "INTERNAL_ERROR", err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return body as T;
}

/**
 * One-off sync: logs in to the bank / card company on the server, imports
 * the transactions and returns how many were added. The credentials are not
 * stored — don't keep them in component state longer than the form submit.
 */
export function syncBankTransactions(
  companyId: string,
  credentials: Record<string, string>,
  startDate: string,
): Promise<BankSyncResult> {
  return apiRequest("POST", "/api/scrape-transactions", { companyId, credentials, startDate });
}

export async function listConnections(): Promise<BankConnection[]> {
  return (await apiRequest<{ connections: BankConnection[] }>("GET", "/api/connections")).connections;
}

/**
 * Connects a provider in one request with one bank login. The server stores
 * nothing until the bank accepts the login; then the connection appears in
 * the live list (verified, status "syncing", connectAttemptId = `attemptId`)
 * while the same session fetches the transactions, and this resolves when the
 * fetch is done. Rejects with the bank's error if the login fails — no
 * connection is created, and an existing one keeps its working credentials.
 */
export function connectAccount(
  companyId: string,
  credentials: Record<string, string>,
  startDate: string,
  attemptId: string,
): Promise<ConnectionSyncResult & { connectionId: string }> {
  return apiRequest("POST", "/api/connections", { companyId, credentials, startDate, attemptId });
}

const ymdOrNull = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const isoOrNull = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : null);

/** A users/{uid}/bankConnections doc as the API would return it (same rules as the server's toConnection). */
function fromDoc(id: string, data: DocumentData): BankConnection {
  return {
    id,
    companyId: data.companyId,
    status: data.status === "syncing" || data.status === "needs_attention" ? data.status : "active",
    syncInProgress: data.syncLockUntil instanceof Timestamp && data.syncLockUntil.toMillis() > Date.now(),
    loginVerified:
      typeof data.loginVerified === "boolean" ? data.loginVerified : data.status === "active" || !!data.lastSyncAt || !data.status,
    connectAttemptId: typeof data.connectAttemptId === "string" ? data.connectAttemptId : null,
    maskedLogin: data.maskedLogin ?? "•••",
    lastErrorCode: data.lastErrorCode ?? null,
    lastSyncAt: isoOrNull(data.lastSyncAt),
    startDate: ymdOrNull(data.startDate),
    syncedFrom: ymdOrNull(data.syncedFrom),
    sessionSavedAt: isoOrNull(data.sessionSavedAt),
  };
}

/**
 * Live connection list, read straight from Firestore (the owner may read
 * bankConnections, never write it), so status changes made by a background
 * sync, another device or the scheduled job show up without polling.
 * Snapshots served only from the local cache are skipped: a stale status
 * would briefly flash. Returns the unsubscribe function.
 */
export function onConnectionsSnapshot(
  callback: (connections: BankConnection[]) => void,
  onError: (err: Error) => void,
): () => void {
  const uid = getUidOrNull();
  if (!uid) return () => {};
  return onSnapshot(
    collection(db, "users", uid, "bankConnections"),
    // Needed to hear the cache → server switch when the data itself didn't change.
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.fromCache) return;
      // Only logins the bank accepted are "connected accounts" (mirrors the server's listConnections).
      callback(snap.docs.map((d) => fromDoc(d.id, d.data())).filter((c) => c.loginVerified));
    },
    onError,
  );
}

/**
 * Syncs a saved connection with its stored credentials. `startDate`
 * (YYYY-MM-DD) overrides where this one sync starts; the saved date is kept.
 */
export function syncConnection(id: string, startDate?: string): Promise<ConnectionSyncResult> {
  return apiRequest("POST", `/api/connections/${encodeURIComponent(id)}/sync`, startDate ? { startDate } : undefined);
}

/** Saves the date future syncs of this connection fetch from (YYYY-MM-DD). */
export async function updateConnectionStartDate(id: string, startDate: string): Promise<BankConnection> {
  return (
    await apiRequest<{ connection: BankConnection }>("PATCH", `/api/connections/${encodeURIComponent(id)}`, { startDate })
  ).connection;
}

export async function removeConnection(id: string): Promise<void> {
  await apiRequest("DELETE", `/api/connections/${encodeURIComponent(id)}`);
}
