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
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export interface BankSyncResult {
  savedCount: number;
  duplicateCount: number;
  skippedPendingCount: number;
  skippedIncomeCount: number;
  accounts: { accountNumber: string; balance: number | null }[];
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

/**
 * Logs in to the bank / card company on the server, imports the transactions
 * into users/{uid}/transactions and returns how many were added. Credentials
 * are sent once over HTTPS and are not stored anywhere — don't keep them in
 * component state longer than the form submit.
 */
export async function syncBankTransactions(
  companyId: string,
  credentials: Record<string, string>,
  startDate: string,
): Promise<BankSyncResult> {
  const user = auth.currentUser;
  if (!user) throw new BankSyncError("UNAUTHENTICATED", "Not signed in");
  const token = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/scrape-transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ companyId, credentials, startDate }),
    });
  } catch {
    throw new BankSyncError("NETWORK_ERROR", "Could not reach the sync server");
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const err = body?.error;
    throw new BankSyncError(err?.code ?? "INTERNAL_ERROR", err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return body as BankSyncResult;
}
