import type { Response } from "express";

/**
 * Every error the API can return. The client switches on `code`; `message`
 * is a human-readable fallback. Status codes for bank-side failures are
 * deliberately NOT 401 so the client never confuses a wrong bank password
 * with an expired app session.
 */
export const API_ERRORS = {
  UNAUTHENTICATED: [401, "Missing, invalid or expired session token"],
  FORBIDDEN: [403, "A Google sign-in is required for this action"],
  INVALID_REQUEST: [400, "Request body is invalid"],
  MISSING_CREDENTIAL_FIELDS: [400, "Required login fields for this company are missing"],
  SCRAPE_IN_PROGRESS: [409, "A sync is already running for this user"],
  SERVER_BUSY: [503, "Too many syncs are running right now, try again shortly"],
  BANK_INVALID_CREDENTIALS: [422, "The bank rejected the login details"],
  BANK_OTP_REQUIRED: [422, "The bank requires a one-time code (OTP), which is not supported"],
  BANK_CHANGE_PASSWORD: [422, "The bank requires a password change; log in on the bank site first"],
  BANK_ACCOUNT_BLOCKED: [423, "The bank account is blocked"],
  BANK_TIMEOUT: [504, "The bank did not respond in time"],
  BANK_ERROR: [502, "The bank site returned an unexpected error"],
  SAVE_FAILED: [500, "Transactions were fetched but could not be saved"],
  CONNECTION_NOT_FOUND: [404, "No such saved connection"],
  CONNECTION_NEEDS_ATTENTION: [409, "This connection needs new login details before it can sync again"],
  CREDENTIAL_STORE_UNAVAILABLE: [500, "The server cannot store credentials right now"],
  AI_NOT_CONFIGURED: [503, "The AI assistant has no API key configured on the server"],
  AI_RATE_LIMITED: [429, "Too many questions, try again in a few minutes"],
  AI_ERROR: [502, "The AI provider returned an error"],
  INTERNAL_ERROR: [500, "Unexpected server error"],
} as const satisfies Record<string, readonly [number, string]>;

export type ApiErrorCode = keyof typeof API_ERRORS;

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export function sendError(res: Response, code: ApiErrorCode, details?: Record<string, unknown>) {
  const [status, message] = API_ERRORS[code];
  res.status(status).json({ success: false, error: { code, message, ...(details && { details }) } });
}
