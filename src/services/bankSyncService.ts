import { auth } from "../lib/firebase";

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
  /** "needs_attention": the bank rejected the login / wants OTP or a password change. */
  status: "active" | "needs_attention";
  /** e.g. "•••789" */
  maskedLogin: string;
  lastErrorCode: string | null;
  /** ISO timestamp */
  lastSyncAt: string | null;
  /** YYYY-MM-DD transactions are fetched from; null for connections saved before this existed. */
  startDate: string | null;
  /** YYYY-MM-DD back to which transactions have actually been fetched. */
  syncedFrom: string | null;
}

/** The start date was moved before what's been fetched; the next sync backfills to it. */
export function needsBackfill(c: BankConnection): boolean {
  return !!c.startDate && (!c.syncedFrom || c.startDate < c.syncedFrom);
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

async function apiRequest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<T> {
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
 * Logs in, imports once, and — only if the login worked — saves the
 * credentials encrypted on the server for future one-click syncs. Replaces
 * any existing connection to the same provider.
 */
export function connectAccount(
  companyId: string,
  credentials: Record<string, string>,
  startDate: string,
): Promise<ConnectionSyncResult> {
  return apiRequest("POST", "/api/connections", { companyId, credentials, startDate });
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
