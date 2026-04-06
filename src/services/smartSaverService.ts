import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import {
  BANKS,
  CREDIT_CARDS,
  CLUBS,
  WALLETS,
  type UserFinancialProfile,
  type FinancialOption,
} from "../types/userProfile";
import type { Transaction } from "../types";
import type { RecurringCharge } from "../utils/recurringBills";
import type { SavingsInsight } from "../types/smartSaver";

// ── Firestore ───────────────────────────────────────────────────

const COLLECTION = "savingsInsights";
const colRef = collection(db, COLLECTION);

export async function getSavedInsights(): Promise<SavingsInsight[]> {
  const q = query(colRef, orderBy("timestamp", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as SavingsInsight);
}

export async function saveInsights(insights: SavingsInsight[]): Promise<void> {
  // Clear old insights first
  const existing = await getDocs(colRef);
  const deletes = existing.docs.map((d) => deleteDoc(d.ref));
  await Promise.all(deletes);

  // Write new
  const writes = insights.map((ins) =>
    setDoc(doc(db, COLLECTION, ins.id), ins),
  );
  await Promise.all(writes);
}

export function onInsightsSnapshot(
  callback: (insights: SavingsInsight[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(colRef, orderBy("timestamp", "desc"));
  return onSnapshot(
    q,
    (snap) => {
      callback(
        snap.docs.map((d) => ({ id: d.id, ...d.data() }) as SavingsInsight),
      );
    },
    onError,
  );
}

// ── Prompt builder (for future AI API) ──────────────────────────

interface ExpenseDetails {
  amount: number;
  category: string;
  businessName: string;
}

function resolveNames(
  ids: string[],
  catalog: FinancialOption[],
): string[] {
  return ids.map((id) => catalog.find((o) => o.id === id)?.name ?? id);
}

export function generatePromptForSmartSaver(
  expense: ExpenseDetails,
  profile: UserFinancialProfile,
): string {
  const parts: string[] = [];

  parts.push(
    `The user has an expense of ${expense.amount} NIS at ${expense.businessName} (category: ${expense.category}).`,
  );

  const banks = resolveNames(profile.banks, BANKS);
  const cards = resolveNames(profile.creditCards, CREDIT_CARDS);
  const clubs = resolveNames(profile.consumerClubs, CLUBS);
  const wallets = resolveNames(profile.walletsAndVouchers, WALLETS);

  if (banks.length > 0) parts.push(`The user banks with: ${banks.join(", ")}.`);
  if (cards.length > 0) parts.push(`The user has these credit cards: ${cards.join(", ")}.`);
  if (clubs.length > 0) parts.push(`The user belongs to these consumer clubs: ${clubs.join(", ")}.`);
  if (wallets.length > 0) parts.push(`The user uses these wallets/vouchers: ${wallets.join(", ")}.`);

  parts.push(
    "Are there any relevant discounts, cashback offers, or better plans the user should know about?",
  );

  return parts.join(" ");
}

// ── Insight generation (skill-based rules engine) ───────────────
//
// Expert persona: Top-tier Israeli financial advisor who knows all the
// unwritten rules of Israeli consumer clubs (Hever, Ashmoret, Hitechzone…).
//
// Applies the israeli-smart-saver skill knowledge:
//   - Subscription audit categories, alternatives & typical costs
//   - Telecom MVNO comparison & retention negotiation
//   - Known deep discounts (Hever ↔ Phoenix/Harel insurance, etc.)
//   - Double-dipping via reloadable club cards (כרטיס נטען, ~5-7% return)
//   - Credit card perk matching
//
// STRICT NEGATIVE CONSTRAINTS:
//   1. NO CASHBACK: Do not suggest third-party cashback websites, apps, or
//      browser extensions (Cashback.co.il, Payback, MaxBack, etc.). Only
//      recommend direct credit card, bank, or consumer club benefits.
//   2. NO HALLUCINATIONS FOR SMALL BUSINESSES: Do not invent or assume
//      specific 1+1 partnerships for small, local, or independent businesses.
//      Only state specific 1+1 benefits for major national chains listed in
//      MAJOR_ENTERTAINMENT_CHAINS. For all other businesses, use only a
//      generic portal-check reminder — never promise a discount.
//
// Phrasing rule: NEVER make legally binding guarantees.
// Use "בדרך כלל", "עשוי להניב", "סביר להניח", "לפי תעריפי שוק".

/** Keywords → category mapping for matching skill knowledge to charges. */
const TELECOM_KW = [
  "סלקום", "פרטנר", "פלאפון", "הוט מובייל", "גולן", "רמי לוי מובייל",
  "cellcom", "partner", "pelephone", "hot mobile", "012",
];
const STREAMING_KW = [
  "נטפליקס", "netflix", "דיסני", "disney", "אפל", "apple tv",
  "הוט", "hot vod", "yes", "ספוטיפי", "spotify", "youtube",
];
const INSURANCE_KW = ["ביטוח", "insurance", "מנורה", "הראל", "כלל", "הפניקס", "מגדל"];
const INTERNET_KW = ["בזק", "bezeq", "אינטרנט", "internet", "סיבים"];
const GYM_KW = ["הולמס", "כושר", "gym", "fitness", "הפועל"];
const SUPERMARKET_KW = [
  "רמי לוי", "שופרסל", "ויקטורי", "יוחננוף", "מגה", "אושר ��ד",
  "חצי חינם", "סופר", "מרקט",
];
const FASHION_KW = [
  "זארה", "zara", "h&m", "קסטרו", "castro", "פוקס", "fox",
  "גולף", "golf", "תמנון", "רנואר", "renuar", "מנגו", "mango",
  "american eagle", "pull&bear",
];
const FX_KW = [
  "amazon", "אמזון", "aliexpress", "אלי אקספרס", "ebay", "איביי",
  "nike", "נייקי", "brooks", "ברוקס", "adidas", "אדידס",
  "booking", "airbnb", "expedia", "hotels.com",
  "steam", "playstation", "app store", "google play",
  "paypal", "פייפאל", "usd", "eur", "gbp",
];
const BANK_FEES_KW = [
  "דמי כרטיס", "עמלת שורה", "עמלת ניהול", "דמי ניהול",
  "עמלה חודשית", "דמי חשבון",
];
const ENTERTAINMENT_KW = [
  "סינמה סיטי", "cinema city", "יס פלנט", "yes planet",
  "לב", "רב חן", "הוט סינמה", "hot cinema",
  "הצגה", "תיאטרון", "theatre", "לונה פארק", "סופרלנד",
];

/** Only these major national chains may receive specific 1+1 claims. */
const MAJOR_ENTERTAINMENT_CHAINS = [
  "סינמה סיטי", "cinema city", "יס פלנט", "yes planet",
  "רב חן", "הוט סינמה", "hot cinema",
  "לונה פארק", "סופרלנד",
  "מקדונלד", "mcdonald",
];

function isMajorChain(desc: string): boolean {
  const lower = desc.toLowerCase();
  return MAJOR_ENTERTAINMENT_CHAINS.some((k) => lower.includes(k));
}

const RESTAURANT_KW = [
  "מסעדה", "מסעדת", "קפה", "בית קפה", "שף", "ביסטרו",
  "מקדונלד", "בורגר", "דומינו", "פיצה", "סושי",
  "אגאדיר", "BBB", "שיפודי",
  "מוזס", "גרג", "ארומה", "לנדוור", "רולדין",
];

type Category =
  | "telecom" | "streaming" | "insurance" | "internet"
  | "gym" | "supermarket" | "fashion"
  | "fx" | "bank_fees" | "entertainment" | "restaurant";

function matchCategory(desc: string): Category | null {
  const lower = desc.toLowerCase();
  // Order matters: more specific checks first
  if (BANK_FEES_KW.some((k) => lower.includes(k))) return "bank_fees";
  if (TELECOM_KW.some((k) => lower.includes(k))) return "telecom";
  if (STREAMING_KW.some((k) => lower.includes(k))) return "streaming";
  if (INSURANCE_KW.some((k) => lower.includes(k))) return "insurance";
  if (INTERNET_KW.some((k) => lower.includes(k))) return "internet";
  if (GYM_KW.some((k) => lower.includes(k))) return "gym";
  if (ENTERTAINMENT_KW.some((k) => lower.includes(k))) return "entertainment";
  if (RESTAURANT_KW.some((k) => lower.includes(k))) return "restaurant";
  if (SUPERMARKET_KW.some((k) => lower.includes(k))) return "supermarket";
  if (FASHION_KW.some((k) => lower.includes(k))) return "fashion";
  if (FX_KW.some((k) => lower.includes(k))) return "fx";
  return null;
}

// ── Club → reloadable-wallet name mapping ─────────────────────────

const CLUB_WALLET_MAP: Record<string, string> = {
  hever: "חבר שלי",
  hatzdaah: "נטען בהצדעה",
  ashmoret: "אשמורת נטען",
  hitechzone: "ZonePay",
  beyahad: "נטען ביחד בשבילך",
  shotrim: "נטען קרנות השוטרים",
  shelach: "נטען שלך",
};

// ── Known deep-discount partnerships (Hever ↔ Phoenix/Harel, etc.) ─

const INSURANCE_PARTNERSHIPS: Record<string, string> = {
  hever: "לחברי חבר יש בדרך כלל שיתוף פעולה עם הפניקס/הראל שעשוי להניב הנחה משמעותית על ביטוח רכב ובריאות.",
  hatzdaah: "מועדון בהצדעה מציע לעיתים הטבות ביטוח ייעודיות לאנשי קבע ומילואים — כדאי לבדוק באתר המועדון.",
  ashmoret: "חברי אשמורת עשויים לקבל הנחות ביטוח דרך שיתופי פעולה עם חברות ביטוח נבחרות.",
};

// ── Low/zero FX fee cards ────────────────────────────────────────

const LOW_FX_CARDS: Record<string, string> = {
  hitechzone: "כרטיס הייטקזון ידוע בעמלות המרה נמוכות במיוחד (בדרך כלל 0%) — מומלץ להשתמש בו לרכישות במט״ח.",
  cal: "חלק מכרטיסי כאל מציעים עמלות המרה מופחתות — כדאי לבדוק את התנאים הספציפיים של הכרטיס שלכם.",
};

// ── Club fee-exemption eligibility ──────────────────────────────

const FEE_EXEMPT_CLUBS = ["hever", "ashmoret", "hitechzone", "hatzdaah", "beyahad", "shotrim"];

// ── 1+1 entertainment perks by card/bank ────────────────────────

const ENTERTAINMENT_PERKS: Record<string, string> = {
  max: "כרטיס מקס מציע בדרך כלל הטבות 1+1 בקולנוע ובמופעים — בדקו באפליקציית מקס.",
  cal: "כאל מציעה לעיתים הטבות 1+1 לקולנוע ואטרקציות נבחרות — בדקו באתר הטבות כאל.",
  isracard: "ישראכרט מציעה מדי פעם הטבות בידור ו-1+1 — שווה לבדוק באפליקציה.",
};
const BANK_ENTERTAINMENT_PERKS: Record<string, string> = {
  poalim: "תוכנית פועלים Wonder כוללת בדרך כלל הטבות 1+1 לקולנוע ואטרקציות.",
  leumi: "לאומי Goodies מציע לעיתים הנחות והטבות 1+1 לבידור ופנאי.",
};

// ── Streaming subscription perks by card ────────────────────────

const STREAMING_CARD_PERKS: Record<string, string> = {
  max: "חלק ממסלולי מקס כוללים חודשים חינם של Disney+ — בדקו אם אתם זכאים באפליקציית מקס.",
  isracard: "ישראכרט מציעה לעיתים הטבות על Wolt Plus ושירותי משלוח — שווה לבדוק באפליקציה.",
  cal: "כאל מציעה מדי פעם הטבות על שירותי סטרימינג ומשלוחים — בדקו באתר ההטבות.",
};

/**
 * Generate savings insights by applying the israeli-smart-saver skill's
 * knowledge base to the user's recurring charges and financial profile.
 *
 * Each insight is constructed with:
 * 1. Expert-persona context (Israeli consumer-club insider knowledge)
 * 2. Specific partnership awareness (Hever ↔ Phoenix/Harel insurance, etc.)
 * 3. Double-dipping via reloadable cards where applicable
 * 4. Safe, high-probability phrasing (never legally binding guarantees)
 * 5. FX fee optimization for foreign-currency purchases
 * 6. Bank/card fee exemption awareness for club members
 * 7. 1+1 entertainment perks via cards and bank programs
 * 8. Gift card arbitrage (BuyMe/Nofashonit/Tav Zahav) for restaurants & retail
 * 9. Subscription perks (free streaming months, delivery services)
 *
 * Pre-filters:
 * - Variable transactions must appear in ≥3 distinct months (the "3-month rule")
 * - Zero-saving insights are stripped from the output
 */
export function generateSavingsInsights(
  charges: RecurringCharge[],
  allTransactions: Transaction[],
  profile: UserFinancialProfile,
): SavingsInsight[] {
  const now = Date.now();
  const insights: SavingsInsight[] = [];

  const clubNames = resolveNames(profile.consumerClubs, CLUBS);

  // Find the user's first reloadable wallet, if any
  const firstWalletClubId = profile.consumerClubs.find((c) => CLUB_WALLET_MAP[c]);
  const firstWalletName = firstWalletClubId ? CLUB_WALLET_MAP[firstWalletClubId] : null;

  // Build a set of recurring descriptions so we skip them in the variable loop
  const recurringDescs = new Set(charges.map((c) => c.description));

  // ── 3-Month Rule: only analyse variable expenses that appear in ≥3 distinct months ──
  const descMonths = new Map<string, Set<string>>();
  for (const tx of allTransactions) {
    if (tx.category === "מקורות הכנסה" || recurringDescs.has(tx.description)) continue;
    let months = descMonths.get(tx.description);
    if (!months) {
      months = new Set();
      descMonths.set(tx.description, months);
    }
    months.add(tx.date.slice(0, 7)); // YYYY-MM
  }
  const frequentDescs = new Set<string>();
  for (const [desc, months] of descMonths) {
    if (months.size >= 3) frequentDescs.add(desc);
  }

  for (const charge of charges) {
    const cat = matchCategory(charge.description);
    if (!cat) continue;
    const amount = Math.round(charge.amountM);

    // ── Telecom: MVNO alternative ───────────────────────────────────
    // Skill ref: Telecom Savings — Golan ~40, Rami Levy ~45, retention dept.
    if (cat === "telecom" && amount > 50) {
      const saving = Math.max(Math.round(amount * 0.4), 20);
      insights.push({
        id: `telecom-${charge.description}-${now}`,
        businessName: charge.description,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText:
          `לפי תעריפי שוק, מפעילים כמו גולן טלקום ורמי לוי מובייל מציעים חבילות דומות ב-40-50 ש״ח. ` +
          `לפני חידוש חוזה, מומלץ להתקשר לשימור לקוחות ולציין שאתם שוקלים מעבר — ` +
          `בדרך כלל ניתן לקבל הנחה של 20-40% ללא החלפת מפעיל.`,
        clubUsed: "שימור לקוחות",
        timestamp: now,
      });
    }

    // ── Streaming: share or rotate ──────────────────────────────────
    // Skill ref: Subscription Audit — family plans, seasonal rotation.
    if (cat === "streaming" && amount > 25) {
      const saving = Math.round(amount * 0.5);
      insights.push({
        id: `streaming-${charge.description}-${now}`,
        businessName: charge.description,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText:
          `מנוי משפחתי (עד 6 משתמשים) עשוי לחסוך כ-50%. ` +
          `אסטרטגיה נוספת: החליפו בין שירותי סטרימינג עונתית במקום לשלם על כולם במקביל — ` +
          `סביר שתחסכו ${saving.toLocaleString("he-IL")} ש״ח בחודש.`,
        clubUsed: "מנוי משפחתי",
        timestamp: now,
      });
    }

    // ── Streaming: subscription perks (free months via cards) ────────
    // Skill ref: Credit Card Perks — Disney+ via Max, Wolt Plus via Isracard.
    if (cat === "streaming") {
      const streamPerk = profile.creditCards
        .map((cid) => ({ cid, tip: STREAMING_CARD_PERKS[cid] }))
        .find((x) => x.tip);
      if (streamPerk) {
        const cardName = resolveNames([streamPerk.cid], CREDIT_CARDS)[0];
        insights.push({
          id: `streaming-perk-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: amount,
          recommendationText:
            `${streamPerk.tip} ` +
            `אם ההטבה פעילה, ייתכן שתוכלו לקבל את השירות הזה בחינם לתקופה מסוימת.`,
          clubUsed: cardName,
          timestamp: now,
        });
      }
    }

    // ── Insurance: known partnerships + annual comparison ───────────
    // Skill ref: Subscription Audit + Hever ↔ Phoenix/Harel partnership.
    if (cat === "insurance" && amount > 80) {
      const saving = Math.round(amount * 0.2);
      // Check for specific deep-discount partnerships
      const partnershipTip = profile.consumerClubs
        .map((cid) => INSURANCE_PARTNERSHIPS[cid])
        .find(Boolean);

      const baseTip = `השוואת ביטוח שנתית עשויה להניב חיסכון של 10-30%.`;
      const clubTip = partnershipTip
        ?? (clubNames.length > 0
          ? `כדאי לבדוק באתר ${clubNames[0]} אם יש הטבות ביטוח ייעודיות לחברי המועדון.`
          : `בדקו אם המועדון שלכם מקיים שיתוף פעולה עם חברות ביטוח.`);

      insights.push({
        id: `insurance-${charge.description}-${now}`,
        businessName: charge.description,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText: `${baseTip} ${clubTip}`,
        clubUsed: partnershipTip ? resolveNames([profile.consumerClubs.find((c) => INSURANCE_PARTNERSHIPS[c])!], CLUBS)[0] : (clubNames[0] ?? "השוואת ביטוח"),
        timestamp: now,
      });
    }

    // ── Internet: bundle & negotiate ────────────────────────────────
    // Skill ref: Subscription Audit — bundle TV+Internet, call retention.
    if (cat === "internet" && amount > 80) {
      const saving = Math.round(amount * 0.25);
      insights.push({
        id: `internet-${charge.description}-${now}`,
        businessName: charge.description,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText:
          `חבילת אינטרנט + טלוויזיה משולבת בדרך כלל זולה מרכישה נפרדת. ` +
          `לפני חידוש חוזה, שיחה עם שימור לקוחות עשויה להניב הנחה של ~25%. ` +
          `ציינו הצעות מתחרות — זה בדרך כלל מה שמוביל להנחה הטובה ביותר.`,
        clubUsed: "שימור לקוחות",
        timestamp: now,
      });
    }

    // ── Gym: municipal alternative ──────────────────────────────────
    // Skill ref: Subscription Audit — municipal gyms much cheaper.
    if (cat === "gym" && amount > 150) {
      const saving = Math.round(amount * 0.5);
      const clubTip = clubNames.length > 0
        ? `חברי ${clubNames[0]} עשויים לקבל הנחה על מנוי בחלק מרשתות הכושר — כדאי לבדוק באתר המועדון.`
        : `בריכות וחדרי כושר עירוניים בדרך כלל זולים משמעותית ממכוני כושר פרטיים.`;
      insights.push({
        id: `gym-${charge.description}-${now}`,
        businessName: charge.description,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText:
          `מתקני כושר עירוניים עולים בדרך כלל 50-100 ש״ח בחודש. ${clubTip}`,
        clubUsed: clubNames[0] ?? "מתקנים עירוניים",
        timestamp: now,
      });
    }

    // ── Supermarket: double-dip with reloadable card ────────────────
    // Skill ref: Cashback Stacking — buy with reloadable club card ~5-7%.
    if (cat === "supermarket" && amount > 200) {
      if (firstWalletClubId && firstWalletName) {
        const saving = Math.round(amount * 0.06);
        const walletClubName = resolveNames([firstWalletClubId], CLUBS)[0];
        insights.push({
          id: `supermarket-reload-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText:
            `טעינת כרטיס "${firstWalletName}" דרך ${walletClubName} מעניקה בדרך כלל ` +
            `החזר של כ-5%-7% על כל רכישה בסופר. על הוצאה חודשית של ` +
            `${amount.toLocaleString("he-IL")} ש״ח, זה עשוי להניב חיסכון של כ-${saving.toLocaleString("he-IL")} ש״ח בחודש.`,
          clubUsed: walletClubName,
          timestamp: now,
        });
      }
    }

    // ── Fashion/Retail: double-dip with reloadable card ─────────────
    // Same strategy as supermarket — reloadable cards work at retail chains.
    if (cat === "fashion" && amount > 100) {
      if (firstWalletClubId && firstWalletName) {
        const saving = Math.round(amount * 0.06);
        const walletClubName = resolveNames([firstWalletClubId], CLUBS)[0];
        insights.push({
          id: `fashion-reload-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText:
            `רכישה דרך כרטיס "${firstWalletName}" של ${walletClubName} ` +
            `מעניקה בדרך כלל כ-5%-7% החזר גם ברשתות אופנה. ` +
            `שילוב עם קאשבק כרטיס אשראי עשוי להגיע לחיסכון כולל של עד 12%.`,
          clubUsed: walletClubName,
          timestamp: now,
        });
      }
    }

    // ── Foreign Exchange: low/zero FX fee card ──────────────────────
    // Skill ref: Credit Card Perks — FX conversion ~1.5-3% on most cards.
    if (cat === "fx") {
      const fxTip = profile.creditCards
        .map((cid) => LOW_FX_CARDS[cid])
        .find(Boolean);
      const saving = Math.round(amount * 0.02);
      if (saving >= 3) {
        insights.push({
          id: `fx-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText: fxTip
            ? `עסקה זו עשויה להיות במט״ח עם עמלת המרה של 1.5%-3%. ${fxTip}`
            : `עסקה זו עשויה להיות במט״ח עם עמלת המרה של 1.5%-3%. ` +
              `כרטיסים מסוימים (כמו הייטקזון) מציעים עמלות המרה נמוכות או אפסיות — ` +
              `כדאי לבדוק אם יש לכם כרטיס מתאים ולהשתמש בו לרכישות בינלאומיות.`,
          clubUsed: fxTip ? "כרטיס עם עמלת מט״ח נמוכה" : "בדיקת עמלות מט״ח",
          timestamp: now,
        });
      }
    }

    // ── Bank/Card Fees: club-based fee exemption ────────────────────
    // Skill ref: Subscription Audit — bank fees 20-50 NIS, negotiate or switch.
    if (cat === "bank_fees") {
      const hasExemptClub = profile.consumerClubs.some((c) =>
        FEE_EXEMPT_CLUBS.includes(c),
      );
      if (hasExemptClub) {
        const exemptClubName = resolveNames(
          [profile.consumerClubs.find((c) => FEE_EXEMPT_CLUBS.includes(c))!],
          CLUBS,
        )[0];
        insights.push({
          id: `fees-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: amount,
          recommendationText:
            `כחברי ${exemptClubName}, סביר להניח שאתם זכאים לפטור מלא מדמי כרטיס ועמלות שורה. ` +
            `פנו לשירות הלקוחות של הבנק/חברת האשראי עם מספר החברות שלכם ובקשו פטור — ` +
            `ברוב המקרים הפטור ניתן באופן מידי.`,
          clubUsed: exemptClubName,
          timestamp: now,
        });
      } else if (amount > 0) {
        insights.push({
          id: `fees-negotiate-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: amount,
          recommendationText:
            `דמי כרטיס ועמלות שורה ניתנים לביטול ברוב המקרים. ` +
            `התקשרו לשירות לקוחות ובקשו פטור — לקוחות ותיקים בדרך כלל מקבלים אותו.`,
          clubUsed: "שירות לקוחות",
          timestamp: now,
        });
      }
    }

    // ── Entertainment: 1+1 perks via cards & bank programs ──────────
    // Only claim specific 1+1 for major national chains; generic tip otherwise.
    if (cat === "entertainment") {
      const cardPerk = profile.creditCards
        .map((cid) => ({ cid, tip: ENTERTAINMENT_PERKS[cid] }))
        .find((x) => x.tip);
      const bankPerk = profile.banks
        .map((bid) => ({ bid, tip: BANK_ENTERTAINMENT_PERKS[bid] }))
        .find((x) => x.tip);
      const perkTip = cardPerk?.tip ?? bankPerk?.tip;

      if (perkTip && isMajorChain(charge.description)) {
        // Specific 1+1 claim — only for verified major chains
        const saving = Math.round(amount * 0.5);
        const via = cardPerk
          ? resolveNames([cardPerk.cid], CREDIT_CARDS)[0]
          : resolveNames([bankPerk!.bid], BANKS)[0];
        insights.push({
          id: `entertainment-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText:
            `${perkTip} ` +
            `הטבת 1+1 על כניסה של ${amount.toLocaleString("he-IL")} ש״ח עשויה לחסוך כ-${saving.toLocaleString("he-IL")} ש״ח.`,
          clubUsed: via,
          timestamp: now,
        });
      } else if (perkTip) {
        // Generic portal-check reminder for non-chain businesses
        const via = cardPerk
          ? resolveNames([cardPerk.cid], CREDIT_CARDS)[0]
          : resolveNames([bankPerk!.bid], BANKS)[0];
        insights.push({
          id: `entertainment-generic-${charge.description}-${now}`,
          businessName: charge.description,
          currentAmount: amount,
          potentialSaving: 0,
          recommendationText:
            `לא נמצאה הטבה ספציפית לעסק הזה. כדאי לבדוק בפורטל ההטבות של ${via} — ` +
            `ייתכן שיש הנחות כלליות לבידור ופנאי שתוכלו לנצל.`,
          clubUsed: via,
          timestamp: now,
        });
      }
    }

    // ── Restaurant: gift card arbitrage ─────────────────────────────
    // Skill ref: BuyMe gift cards at 5-15% discount, Nofashonit, Tav Zahav.
    if (cat === "restaurant" && amount > 80) {
      const saving = Math.round(amount * 0.1);
      const hasClub = clubNames.length > 0;
      insights.push({
        id: `restaurant-giftcard-${charge.description}-${now}`,
        businessName: charge.description,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText:
          `לפני תשלום מחיר מלא, בדקו אם ניתן לרכוש שובר BuyMe, נופשונית או תו זהב ` +
          `להקבוצה/מסעדה הזו בהנחה של 5-15%. ` +
          (hasClub
            ? `חברי ${clubNames[0]} מקבלים לעיתים הנחות נוספות על רכישת שוברים באתר המועדון.`
            : `שוברים מוזלים זמינים לרוב באתרי BuyMe ו-Nofashonit.`),
        clubUsed: hasClub ? clubNames[0] : "שובר מוזל",
        timestamp: now,
      });
    }
  }

  // ── Variable transactions analysis ────────────────────────────────
  // Aggregate variable (non-recurring) transactions that pass the 3-month rule.
  // We compute a monthly average across all months the description appears in.
  const varAgg = new Map<string, { totalAll: number; monthCount: number }>();
  for (const tx of allTransactions) {
    if (tx.category === "מקורות הכנסה" || recurringDescs.has(tx.description)) continue;
    if (!frequentDescs.has(tx.description)) continue;
    const existing = varAgg.get(tx.description);
    if (existing) {
      existing.totalAll += tx.amount;
    } else {
      varAgg.set(tx.description, {
        totalAll: tx.amount,
        monthCount: descMonths.get(tx.description)!.size,
      });
    }
  }

  for (const [desc, { totalAll, monthCount }] of varAgg) {
    const cat = matchCategory(desc);
    if (!cat) continue;
    const amount = Math.round(totalAll / monthCount); // monthly average

    // FX: low/zero FX fee card
    if (cat === "fx") {
      const fxTip = profile.creditCards
        .map((cid) => LOW_FX_CARDS[cid])
        .find(Boolean);
      const saving = Math.round(amount * 0.02);
      if (saving >= 3) {
        insights.push({
          id: `fx-var-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText: fxTip
            ? `עסקה זו עשויה להיות במט״ח עם עמלת המרה של 1.5%-3%. ${fxTip}`
            : `עסקה זו עשויה להיות במט״ח עם עמלת המרה של 1.5%-3%. ` +
              `כרטיסים מסוימים (כמו הייטקזון) מציעים עמלות המרה נמוכות או אפסיות — ` +
              `כדאי לבדוק אם יש לכם כרטיס מתאים ולהשתמש בו לרכישות בינלאומיות.`,
          clubUsed: fxTip ? "כרטיס עם עמלת מט״ח נמוכה" : "בדיקת עמלות מט״ח",
          timestamp: now,
        });
      }
    }

    // Bank/Card Fees: club-based fee exemption
    if (cat === "bank_fees") {
      const hasExemptClub = profile.consumerClubs.some((c) =>
        FEE_EXEMPT_CLUBS.includes(c),
      );
      if (hasExemptClub) {
        const exemptClubName = resolveNames(
          [profile.consumerClubs.find((c) => FEE_EXEMPT_CLUBS.includes(c))!],
          CLUBS,
        )[0];
        insights.push({
          id: `fees-var-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: amount,
          recommendationText:
            `כחברי ${exemptClubName}, סביר להניח שאתם זכאים לפטור מלא מדמי כרטיס ועמלות שורה. ` +
            `פנו לשירות הלקוחות של הבנק/חברת האשראי עם מספר החברות שלכם ובקשו פטור — ` +
            `ברוב המקרים הפטור ניתן באופן מידי.`,
          clubUsed: exemptClubName,
          timestamp: now,
        });
      } else if (amount > 0) {
        insights.push({
          id: `fees-var-negotiate-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: amount,
          recommendationText:
            `דמי כרטיס ועמלות שורה ניתנים לביטול ברוב המקרים. ` +
            `התקשרו לשירות לקוחות ובקשו פטור — לקוחות ותיקים בדרך כלל מקבלים אותו.`,
          clubUsed: "שירות לקוחות",
          timestamp: now,
        });
      }
    }

    // Entertainment: 1+1 perks — only specific claims for major chains
    if (cat === "entertainment") {
      const cardPerk = profile.creditCards
        .map((cid) => ({ cid, tip: ENTERTAINMENT_PERKS[cid] }))
        .find((x) => x.tip);
      const bankPerk = profile.banks
        .map((bid) => ({ bid, tip: BANK_ENTERTAINMENT_PERKS[bid] }))
        .find((x) => x.tip);
      const perkTip = cardPerk?.tip ?? bankPerk?.tip;

      if (perkTip && isMajorChain(desc)) {
        const saving = Math.round(amount * 0.5);
        const via = cardPerk
          ? resolveNames([cardPerk.cid], CREDIT_CARDS)[0]
          : resolveNames([bankPerk!.bid], BANKS)[0];
        insights.push({
          id: `entertainment-var-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText:
            `${perkTip} ` +
            `הטבת 1+1 על כניסה של ${amount.toLocaleString("he-IL")} ש״ח עשויה לחסוך כ-${saving.toLocaleString("he-IL")} ש״ח.`,
          clubUsed: via,
          timestamp: now,
        });
      } else if (perkTip) {
        const via = cardPerk
          ? resolveNames([cardPerk.cid], CREDIT_CARDS)[0]
          : resolveNames([bankPerk!.bid], BANKS)[0];
        insights.push({
          id: `entertainment-var-generic-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: 0,
          recommendationText:
            `לא נמצאה הטבה ספציפית לעסק הזה. כדאי לבדוק בפורטל ההטבות של ${via} — ` +
            `ייתכן שיש הנחות כלליות לבידור ופנאי שתוכלו לנצל.`,
          clubUsed: via,
          timestamp: now,
        });
      }
    }

    // Restaurant: gift card arbitrage
    if (cat === "restaurant" && amount > 80) {
      const saving = Math.round(amount * 0.1);
      const hasClub = clubNames.length > 0;
      insights.push({
        id: `restaurant-var-giftcard-${desc}-${now}`,
        businessName: desc,
        currentAmount: amount,
        potentialSaving: saving,
        recommendationText:
          `לפני תשלום מחיר מלא, בדקו אם ניתן לרכוש שובר BuyMe, נופשונית או תו זהב ` +
          `להקבוצה/מסעדה הזו בהנחה של 5-15%. ` +
          (hasClub
            ? `חברי ${clubNames[0]} מקבלים לעיתים הנחות נוספות על רכישת שוברים באתר המועדון.`
            : `שוברים מוזלים זמינים לרוב באתרי BuyMe ו-Nofashonit.`),
        clubUsed: hasClub ? clubNames[0] : "שובר מוזל",
        timestamp: now,
      });
    }

    // Supermarket: double-dip with reloadable card (variable spend)
    if (cat === "supermarket" && amount > 200) {
      if (firstWalletClubId && firstWalletName) {
        const saving = Math.round(amount * 0.06);
        const walletClubName = resolveNames([firstWalletClubId], CLUBS)[0];
        insights.push({
          id: `supermarket-var-reload-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText:
            `טעינת כרטיס "${firstWalletName}" דרך ${walletClubName} מעניקה בדרך כלל ` +
            `החזר של כ-5%-7% על כל רכישה בסופר. על הוצאה חודשית של ` +
            `${amount.toLocaleString("he-IL")} ש״ח, זה עשוי להניב חיסכון של כ-${saving.toLocaleString("he-IL")} ש״ח בחודש.`,
          clubUsed: walletClubName,
          timestamp: now,
        });
      }
    }

    // Fashion/Retail: double-dip with reloadable card (variable spend)
    if (cat === "fashion" && amount > 100) {
      if (firstWalletClubId && firstWalletName) {
        const saving = Math.round(amount * 0.06);
        const walletClubName = resolveNames([firstWalletClubId], CLUBS)[0];
        insights.push({
          id: `fashion-var-reload-${desc}-${now}`,
          businessName: desc,
          currentAmount: amount,
          potentialSaving: saving,
          recommendationText:
            `רכישה דרך כרטיס "${firstWalletName}" של ${walletClubName} ` +
            `מעניקה בדרך כלל כ-5%-7% החזר גם ברשתות אופנה. ` +
            `שילוב עם קאשבק כרטיס אשראי עשוי להגיע לחיסכון כולל של עד 12%.`,
          clubUsed: walletClubName,
          timestamp: now,
        });
      }
    }
  }

  // Strip any insight with zero potential saving (generic-only advice = noise)
  return insights.filter((i) => i.potentialSaving > 0);
}
