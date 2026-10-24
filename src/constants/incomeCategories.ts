import { INTERNAL_TRANSFERS, INCOME_TRANSFER_SUBCATEGORIES } from "../utils/internalTransfers";

/**
 * Default income categories (סעיפי הכנסה).
 * Separate from expense categories to avoid conflicts.
 */
export const INCOME_CATEGORIES: Record<string, string[]> = {
  "משכורת": [
    "משכורת נטו",
    "בונוס",
    "שעות נוספות",
    "דמי הבראה",
    "קצובת נסיעות",
  ],
  "העברות מלקוחות": [
    "תשלום ללקוח",
    "פרילנס",
    "ייעוץ",
  ],
  "החזרים": [
    "החזר מס",
    "החזר ביטוח",
    "זיכוי עסקה",
    "החזר כספי",
  ],
  "קצבאות": [
    "ביטוח לאומי",
    "קצבת ילדים",
    "קצבת נכות",
    "מלגה",
  ],
  "הכנסות מנכסים": [
    "דמי שכירות",
    "דיבידנדים",
    "ריבית",
  ],
  "שונות": [
    "העברה בנקאית",
    "הכנסה אחרת",
  ],
  // Not income — flagged excludeFromIncomeTotals when seeded.
  [INTERNAL_TRANSFERS]: INCOME_TRANSFER_SUBCATEGORIES,
};
