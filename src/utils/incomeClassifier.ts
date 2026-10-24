/**
 * Auto-classification engine for income transactions.
 * Separate from the expense classifier to avoid mapping conflicts.
 */

import { findLearnedRule } from "./descriptionKey.js";
import { INTERNAL_TRANSFERS } from "./internalTransfers.js";

export type MatchSource = "learned" | "system";

export interface ClassificationResult {
  category: string;
  subCategory: string;
  source: MatchSource;
}

export interface UserMapping {
  description: string;
  category: string;
  subCategory: string;
}

interface Rule {
  keyword: string;
  category: string;
  subCategory: string;
}

const RULES: Rule[] = [
  // ─── העברות פנימיות — not income; checked first so the generic
  // "העברה" rule below never claims them ───────────────────────
  { keyword: "העברה בין חשבונות", category: INTERNAL_TRANSFERS, subCategory: "העברה בין חשבונות" },
  { keyword: "העברה עצמית", category: INTERNAL_TRANSFERS, subCategory: "העברה עצמית" },
  { keyword: "מכירת ני", category: INTERNAL_TRANSFERS, subCategory: "מימוש נייר ערך / השקעה" },
  { keyword: "מכירת נ\"ע", category: INTERNAL_TRANSFERS, subCategory: "מימוש נייר ערך / השקעה" },
  { keyword: "פדיון פיקדון", category: INTERNAL_TRANSFERS, subCategory: "פדיון פיקדון" },
  { keyword: "פדיון פקדון", category: INTERNAL_TRANSFERS, subCategory: "פדיון פיקדון" },
  { keyword: "פירעון פיקדון", category: INTERNAL_TRANSFERS, subCategory: "פדיון פיקדון" },
  { keyword: "פירעון פקדון", category: INTERNAL_TRANSFERS, subCategory: "פדיון פיקדון" },
  { keyword: "הלוואה", category: INTERNAL_TRANSFERS, subCategory: "הלוואה שהתקבלה" },

  // ─── משכורת ────────────────────────────────────────────────
  { keyword: "משכורת", category: "משכורת", subCategory: "משכורת נטו" },
  { keyword: "שכר", category: "משכורת", subCategory: "משכורת נטו" },
  { keyword: "SALARY", category: "משכורת", subCategory: "משכורת נטו" },
  { keyword: "בונוס", category: "משכורת", subCategory: "בונוס" },
  { keyword: "הבראה", category: "משכורת", subCategory: "דמי הבראה" },

  // ─── העברות / פרילנס ───────────────────────────────────────
  { keyword: "פרילנס", category: "העברות מלקוחות", subCategory: "פרילנס" },
  // A bare transfer could be anything (a client, family, a friend), so it
  // isn't assumed to be work income.
  { keyword: "העברה", category: "שונות", subCategory: "העברה בנקאית" },

  // ─── החזרים ────────────────────────────────────────────────
  { keyword: "החזר מס", category: "החזרים", subCategory: "החזר מס" },
  { keyword: "זיכוי", category: "החזרים", subCategory: "זיכוי עסקה" },
  { keyword: "החזר", category: "החזרים", subCategory: "החזר כספי" },

  // ─── קצבאות ────────────────────────────────────────────────
  { keyword: "ביטוח לאומי", category: "קצבאות", subCategory: "ביטוח לאומי" },
  { keyword: "קצבת ילדים", category: "קצבאות", subCategory: "קצבת ילדים" },
  { keyword: "קצבה", category: "קצבאות", subCategory: "ביטוח לאומי" },
  { keyword: "מלגה", category: "קצבאות", subCategory: "מלגה" },

  // ─── הכנסות מנכסים ────────────────────────────────────────
  { keyword: "שכירות", category: "הכנסות מנכסים", subCategory: "דמי שכירות" },
  { keyword: "דיבידנד", category: "הכנסות מנכסים", subCategory: "דיבידנדים" },
  { keyword: "ריבית", category: "הכנסות מנכסים", subCategory: "ריבית" },
];

/**
 * Suggest a category for an income transaction description.
 *
 * Priority:
 *  1. User-learned income mappings (from Firestore)
 *  2. Hardcoded keyword rules
 */
export function suggestIncomeCategory(
  description: string,
  userMappings?: UserMapping[],
): ClassificationResult | undefined {
  const lower = description.toLowerCase();

  // 1. Check user-learned mappings first
  const learned = findLearnedRule(description, userMappings);
  if (learned) {
    return {
      category: learned.category,
      subCategory: learned.subCategory,
      source: "learned",
    };
  }

  // 2. Fallback to hardcoded keyword rules
  const rule = RULES.find((r) => lower.includes(r.keyword.toLowerCase()));
  if (!rule) return undefined;
  return {
    category: rule.category,
    subCategory: rule.subCategory,
    source: "system",
  };
}
