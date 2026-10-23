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
    INTERNAL_ERROR: [500, "Unexpected server error"],
};
export class ApiError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
    }
}
export function sendError(res, code, details) {
    const [status, message] = API_ERRORS[code];
    res.status(status).json({ success: false, error: { code, message, ...(details && { details }) } });
}
