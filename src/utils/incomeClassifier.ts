/**
 * Auto-classification engine for income transactions.
 * Separate from the expense classifier to avoid mapping conflicts.
 */

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
  // ─── משכורת ────────────────────────────────────────────────
  { keyword: "משכורת", category: "משכורת", subCategory: "משכורת נטו" },
  { keyword: "שכר", category: "משכורת", subCategory: "משכורת נטו" },
  { keyword: "SALARY", category: "משכורת", subCategory: "משכורת נטו" },
  { keyword: "בונוס", category: "משכורת", subCategory: "בונוס" },
  { keyword: "הבראה", category: "משכורת", subCategory: "דמי הבראה" },

  // ─── העברות / פרילנס ───────────────────────────────────────
  { keyword: "העברה", category: "העברות מלקוחות", subCategory: "העברה בנקאית" },
  { keyword: "פרילנס", category: "העברות מלקוחות", subCategory: "פרילנס" },

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
  if (userMappings && userMappings.length > 0) {
    for (const m of userMappings) {
      if (lower.includes(m.description.toLowerCase())) {
        return {
          category: m.category,
          subCategory: m.subCategory,
          source: "learned",
        };
      }
    }
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
