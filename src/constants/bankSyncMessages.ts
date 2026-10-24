import type { BankSyncErrorCode } from "../services/bankSyncService";

// Bank-side login failures, shared by the error-code and scraper-error maps below.
const INVALID_CREDENTIALS = "פרטי ההתחברות (שם משתמש או סיסמה) שגויים. אנא בדקו את הפרטים ונסו שוב.";
const OTP_REQUIRED = "נדרש קוד אימות שנשלח ב-SMS. יש לאשר התחברות באתר הבנק תחילה.";
const ACCOUNT_BLOCKED = "החשבון נחסם זמנית על ידי הבנק/חברת האשראי. יש לפנות לשירות הלקוחות.";
const CHANGE_PASSWORD = "הבנק מבקש להחליף סיסמה. היכנסו לאתר הבנק, עדכנו את הסיסמה ונסו שוב.";
const NO_RESPONSE = "לא התקבלה תגובה מאתר הבנק או שהחיבור נותק. נסו שוב מאוחר יותר.";

export const ERROR_MESSAGES: Record<BankSyncErrorCode, string> = {
  UNAUTHENTICATED: "פג תוקף ההתחברות לאפליקציה. התחברו מחדש ונסו שוב.",
  FORBIDDEN: "הסנכרון זמין רק למשתמשים שהתחברו עם Google.",
  INVALID_REQUEST: "חלק מהפרטים שהוזנו אינם תקינים. בדקו את הטופס ונסו שוב.",
  MISSING_CREDENTIAL_FIELDS: "חסרים פרטי התחברות. מלאו את כל השדות ונסו שוב.",
  SCRAPE_IN_PROGRESS: "סנכרון קודם עדיין פועל. המתינו לסיומו ונסו שוב.",
  SERVER_BUSY: "שרת הסנכרון עמוס כרגע. נסו שוב בעוד דקה.",
  BANK_INVALID_CREDENTIALS: INVALID_CREDENTIALS,
  BANK_OTP_REQUIRED: OTP_REQUIRED,
  BANK_CHANGE_PASSWORD: CHANGE_PASSWORD,
  BANK_ACCOUNT_BLOCKED: ACCOUNT_BLOCKED,
  BANK_TIMEOUT: NO_RESPONSE,
  BANK_ERROR: NO_RESPONSE,
  SAVE_FAILED: "העסקאות נמשכו אך השמירה נכשלה. אפשר לנסות שוב — עסקאות לא ישוכפלו.",
  CONNECTION_NOT_FOUND: "החיבור לא נמצא — ייתכן שנמחק. רעננו ונסו שוב.",
  CONNECTION_NEEDS_ATTENTION: "החיבור דורש עדכון פרטי התחברות לפני סנכרון נוסף.",
  CREDENTIAL_STORE_UNAVAILABLE: "שרת הסנכרון לא יכול לשמור פרטי התחברות כרגע. נסו לסנכרן בלי לשמור.",
  INTERNAL_ERROR: "אירעה שגיאה בלתי צפויה. נסו שוב.",
  NETWORK_ERROR: import.meta.env.DEV
    ? "שרת הסנכרון המקומי לא פועל. הפעילו אותו עם npm run dev:server (או npm run dev:all) ונסו שוב."
    : "לא ניתן להתחבר לשרת הסנכרון. בדקו את החיבור לאינטרנט ונסו שוב.",
};

/** By the scraper's own errorType (israeli-bank-scrapers ScraperErrorTypes), sent as `details.scraperErrorType`. */
const SCRAPER_ERROR_MESSAGES: Record<string, string> = {
  INVALID_PASSWORD: INVALID_CREDENTIALS,
  TWO_FACTOR_RETRIEVER_MISSING: OTP_REQUIRED,
  OTP: OTP_REQUIRED,
  CHANGE_PASSWORD,
  ACCOUNT_BLOCKED,
  TIMEOUT: NO_RESPONSE,
  GENERIC: NO_RESPONSE,
  GENERAL_ERROR: NO_RESPONSE,
};

/**
 * The message for a failed sync: the scraper's exact errorType when the
 * server reported one, otherwise the API error code.
 */
export function syncErrorMessage(code: BankSyncErrorCode, details?: Record<string, unknown>): string {
  const scraperErrorType = details?.scraperErrorType;
  return (typeof scraperErrorType === "string" && SCRAPER_ERROR_MESSAGES[scraperErrorType]) || ERROR_MESSAGES[code];
}

/** Why a saved connection needs the user, from its `lastErrorCode`. */
const ATTENTION_REASONS: Record<string, string> = {
  BANK_INVALID_CREDENTIALS: "הבנק דחה את פרטי ההתחברות השמורים. עדכנו אותם כדי להמשיך.",
  BANK_OTP_REQUIRED: "הבנק דורש קוד חד-פעמי (SMS). היכנסו לאתר הבנק, ואז עדכנו את פרטי ההתחברות.",
  BANK_CHANGE_PASSWORD: "הבנק מבקש להחליף סיסמה. החליפו אותה באתר הבנק ועדכנו כאן.",
  BANK_ACCOUNT_BLOCKED: "הגישה לחשבון חסומה. שחררו את החסימה מול הבנק ועדכנו את פרטי ההתחברות.",
  CREDENTIALS_UNREADABLE: "לא ניתן לפענח את פרטי ההתחברות השמורים. הזינו אותם מחדש.",
};

export function attentionReason(lastErrorCode: string | null): string {
  return (lastErrorCode && ATTENTION_REASONS[lastErrorCode]) ?? "החיבור דורש עדכון פרטי התחברות.";
}
