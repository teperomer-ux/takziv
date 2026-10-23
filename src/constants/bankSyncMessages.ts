import type { BankSyncErrorCode } from "../services/bankSyncService";

export const ERROR_MESSAGES: Record<BankSyncErrorCode, string> = {
  UNAUTHENTICATED: "פג תוקף ההתחברות לאפליקציה. התחברו מחדש ונסו שוב.",
  FORBIDDEN: "הסנכרון זמין רק למשתמשים שהתחברו עם Google.",
  INVALID_REQUEST: "חלק מהפרטים שהוזנו אינם תקינים. בדקו את הטופס ונסו שוב.",
  MISSING_CREDENTIAL_FIELDS: "חסרים פרטי התחברות. מלאו את כל השדות ונסו שוב.",
  SCRAPE_IN_PROGRESS: "סנכרון קודם עדיין פועל. המתינו לסיומו ונסו שוב.",
  SERVER_BUSY: "שרת הסנכרון עמוס כרגע. נסו שוב בעוד דקה.",
  BANK_INVALID_CREDENTIALS:
    "פרטי ההתחברות שגויים. בדקו אותם ונסו שוב — שימו לב שכמה ניסיונות כושלים ברצף עלולים לחסום את הגישה לחשבון.",
  BANK_OTP_REQUIRED: "הבנק דורש קוד חד-פעמי (OTP) בכניסה, ואפשרות זו עדיין לא נתמכת בסנכרון האוטומטי.",
  BANK_CHANGE_PASSWORD: "הבנק מבקש להחליף סיסמה. היכנסו לאתר הבנק, עדכנו את הסיסמה ונסו שוב.",
  BANK_ACCOUNT_BLOCKED: "הגישה לחשבון חסומה. פנו לבנק או לחברת האשראי כדי לשחרר את החסימה.",
  BANK_TIMEOUT: "אתר הבנק לא הגיב בזמן. נסו שוב בעוד כמה דקות.",
  BANK_ERROR: "אתר הבנק החזיר שגיאה לא צפויה. נסו שוב מאוחר יותר.",
  SAVE_FAILED: "העסקאות נמשכו אך השמירה נכשלה. אפשר לנסות שוב — עסקאות לא ישוכפלו.",
  CONNECTION_NOT_FOUND: "החיבור לא נמצא — ייתכן שנמחק. רעננו ונסו שוב.",
  CONNECTION_NEEDS_ATTENTION: "החיבור דורש עדכון פרטי התחברות לפני סנכרון נוסף.",
  CREDENTIAL_STORE_UNAVAILABLE: "שרת הסנכרון לא יכול לשמור פרטי התחברות כרגע. נסו לסנכרן בלי לשמור.",
  INTERNAL_ERROR: "אירעה שגיאה בלתי צפויה. נסו שוב.",
  NETWORK_ERROR: import.meta.env.DEV
    ? "שרת הסנכרון המקומי לא פועל. הפעילו אותו עם npm run dev:server (או npm run dev:all) ונסו שוב."
    : "לא ניתן להתחבר לשרת הסנכרון. בדקו את החיבור לאינטרנט ונסו שוב.",
};

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
