/**
 * Auto-classification engine.
 * Given a transaction description (בית עסק), returns the best-matching
 * category (סעיף) and sub-category (תת סעיף) based on:
 *   1. User-learned mappings (highest priority)
 *   2. Hardcoded keyword rules (fallback)
 */

export type MatchSource = "learned" | "system";

export interface ClassificationResult {
  category: string;
  subCategory: string;
  source: MatchSource;
}

interface Rule {
  keyword: string;
  category: string;
  subCategory: string;
}

export interface UserMapping {
  description: string;
  category: string;
  subCategory: string;
}

/**
 * Rules are ordered so more-specific keywords come first within each group.
 * All matching is case-insensitive and works for both Hebrew and English.
 */
const RULES: Rule[] = [
  // ─── פנאי ובידור ──────────────────────────────────────────
  { keyword: "WOLT", category: "פנאי ובידור", subCategory: "WOLT" },
  { keyword: "וולט", category: "פנאי ובידור", subCategory: "WOLT" },
  { keyword: "TENBIS", category: "פנאי ובידור", subCategory: "מסעדות ובתי קפה" },
  { keyword: "תן ביס", category: "פנאי ובידור", subCategory: "מסעדות ובתי קפה" },
  { keyword: "NETFLIX", category: "פנאי ובידור", subCategory: "מנויים" },
  { keyword: "SPOTIFY", category: "פנאי ובידור", subCategory: "מנויים" },
  { keyword: "APPLE.COM", category: "פנאי ובידור", subCategory: "מנויים" },
  { keyword: "DISNEY", category: "פנאי ובידור", subCategory: "מנויים" },
  { keyword: "YES PLANET", category: "פנאי ובידור", subCategory: "תרבות ובילויים" },
  { keyword: "סינמה", category: "פנאי ובידור", subCategory: "תרבות ובילויים" },
  { keyword: "BOOKING", category: "פנאי ובידור", subCategory: "חופשות ונופש" },
  { keyword: "AIRBNB", category: "פנאי ובידור", subCategory: "חופשות ונופש" },

  // ─── מזון וטיפוח ──────────────────────────────────────────
  { keyword: "רמי לוי", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "שופרסל", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "יוחננוף", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "ויקטורי", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "אושר עד", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "מחסני השוק", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "AM:PM", category: "מזון וטיפוח", subCategory: "סופרמרקט" },
  { keyword: "סופר פארם", category: "מזון וטיפוח", subCategory: "טיפוח אישי" },

  // ─── תחבורה ────────────────────────────────────────────────
  { keyword: "פנגו", category: "תחבורה", subCategory: "חניה - פנגו" },
  { keyword: "PANGO", category: "תחבורה", subCategory: "חניה - פנגו" },
  { keyword: "סלופארק", category: "תחבורה", subCategory: "חניה - סלופארק" },
  { keyword: "CELLOPARK", category: "תחבורה", subCategory: "חניה - סלופארק" },
  { keyword: "סונול", category: "תחבורה", subCategory: "דלק" },
  { keyword: "דור אלון", category: "תחבורה", subCategory: "דלק" },
  { keyword: "פז ", category: "תחבורה", subCategory: "דלק" },
  { keyword: "TEN דלק", category: "תחבורה", subCategory: "דלק" },
  { keyword: "דלק", category: "תחבורה", subCategory: "דלק" },
  { keyword: "רב קו", category: "תחבורה", subCategory: "תחבורה ציבורית" },
  { keyword: "GETT", category: "תחבורה", subCategory: "תחבורה ציבורית" },
  { keyword: "YANGO", category: "תחבורה", subCategory: "תחבורה ציבורית" },
  { keyword: "כביש 6", category: "תחבורה", subCategory: "כבישי אגרה" },
  { keyword: "כרמל מנהרות", category: "תחבורה", subCategory: "כבישי אגרה" },

  // ─── דיור ──────────────────────────────────────────────────
  { keyword: "מילגרם", category: "דיור", subCategory: "דירה בהנחה (מילגרם)" },
  { keyword: "MILGRAM", category: "דיור", subCategory: "דירה בהנחה (מילגרם)" },
  { keyword: "חברת החשמל", category: "דיור", subCategory: "חשמל" },
  { keyword: "IEC", category: "דיור", subCategory: "חשמל" },
  { keyword: "עירית", category: "דיור", subCategory: "ארנונה ומים" },
  { keyword: "עיריית", category: "דיור", subCategory: "ארנונה ומים" },
  { keyword: "מקורות", category: "דיור", subCategory: "ארנונה ומים" },
  { keyword: "מי אביבים", category: "דיור", subCategory: "ארנונה ומים" },
  { keyword: "גז", category: "דיור", subCategory: "גז" },
  { keyword: "IKEA", category: "דיור", subCategory: "ריהוט וציוד לבית" },
  { keyword: "איקאה", category: "דיור", subCategory: "ריהוט וציוד לבית" },
  { keyword: "ACE", category: "דיור", subCategory: "תיקונים ושיפוצים" },

  // ─── תקשורת ────────────────────────────────────────────────
  { keyword: "פלאפון", category: "תקשורת", subCategory: "סלולר" },
  { keyword: "סלקום", category: "תקשורת", subCategory: "סלולר" },
  { keyword: "פרטנר", category: "תקשורת", subCategory: "סלולר" },
  { keyword: "012", category: "תקשורת", subCategory: "סלולר" },
  { keyword: "גולן טלקום", category: "תקשורת", subCategory: "סלולר" },
  { keyword: "HOT", category: "תקשורת", subCategory: "אינטרנט וטלוויזיה" },
  { keyword: "בזק", category: "תקשורת", subCategory: "אינטרנט וטלוויזיה" },
  { keyword: "YES", category: "תקשורת", subCategory: "אינטרנט וטלוויזיה" },

  // ─── בריאות ────────────────────────────────────────────────
  { keyword: "מכבי", category: "בריאות", subCategory: "קופת חולים" },
  { keyword: "כללית", category: "בריאות", subCategory: "קופת חולים" },
  { keyword: "לאומית", category: "בריאות", subCategory: "קופת חולים" },
  { keyword: "מאוחדת", category: "בריאות", subCategory: "קופת חולים" },
  { keyword: "בית מרקחת", category: "בריאות", subCategory: "תרופות" },
  { keyword: "פארם", category: "בריאות", subCategory: "תרופות" },
  { keyword: "אופטיק", category: "בריאות", subCategory: "אופטיקה" },

  // ─── ביגוד והנעלה ─────────────────────────────────────────
  { keyword: "ZARA", category: "ביגוד והנעלה", subCategory: "ביגוד" },
  { keyword: "H&M", category: "ביגוד והנעלה", subCategory: "ביגוד" },
  { keyword: "SHEIN", category: "ביגוד והנעלה", subCategory: "ביגוד" },
  { keyword: "FOX", category: "ביגוד והנעלה", subCategory: "ביגוד" },
  { keyword: "קסטרו", category: "ביגוד והנעלה", subCategory: "ביגוד" },
  { keyword: "נעלי", category: "ביגוד והנעלה", subCategory: "הנעלה" },

  // ─── עמלות ודמי ניהול ─────────────────────────────────────
  { keyword: "עמלת", category: "עמלות ודמי ניהול", subCategory: "עמלות בנק" },
  { keyword: "דמי ניהול", category: "עמלות ודמי ניהול", subCategory: "דמי ניהול חשבון" },
  { keyword: "דמי כרטיס", category: "עמלות ודמי ניהול", subCategory: "עמלות כרטיס אשראי" },

  // ─── מיסים ────────────────────────────────────────────────
  { keyword: "מס הכנסה", category: "מיסים", subCategory: "מס הכנסה" },
  { keyword: "ביטוח לאומי", category: "מיסים", subCategory: "ביטוח לאומי" },

  // ─── חינוך ────────────────────────────────────────────────
  { keyword: "גן ילדים", category: "חינוך", subCategory: "גן ילדים / צהרון" },
  { keyword: "צהרון", category: "חינוך", subCategory: "גן ילדים / צהרון" },
  { keyword: "חוג", category: "חינוך", subCategory: "חוגים" },

  // ─── מתנות ותרומות ────────────────────────────────────────
  { keyword: "תרומ", category: "מתנות ותרומות", subCategory: "תרומות" },
];

/**
 * Suggest a category and sub-category for a transaction description.
 *
 * Priority:
 *  1. User-learned mappings (from Firestore `learnedMappings` collection)
 *  2. Hardcoded keyword rules
 *
 * @param description  The business name / transaction description
 * @param userMappings Optional array of user-learned mappings to check first
 * @returns            Classification result with source indicator, or undefined
 */
export function suggestCategory(
  description: string,
  userMappings?: UserMapping[]
): ClassificationResult | undefined {
  const lower = description.toLowerCase();

  // ── 1. Check user-learned mappings first ──────────────────────────
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

  // ── 2. Fallback to hardcoded keyword rules ────────────────────────
  const rule = RULES.find((r) => lower.includes(r.keyword.toLowerCase()));
  if (!rule) return undefined;
  return {
    category: rule.category,
    subCategory: rule.subCategory,
    source: "system",
  };
}

/** @deprecated Use suggestCategory instead */
export const classify = suggestCategory;
