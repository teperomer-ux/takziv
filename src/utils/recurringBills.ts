/**
 * Fixed-charge detection ("חיובים קבועים").
 *
 * A fixed charge is a subscription, standing order, utility bill or
 * installment plan: money that leaves on its own, about once a month, on
 * about the same day, for about the same amount. A shop the user simply
 * visits often (supermarket, café, fuel, Wolt) is NOT one, however many
 * months it appears in.
 *
 * Rules, per merchant, looking at up to the last 6 charges:
 *  1. Frequency — consecutive charges are ~a month apart (24–38 days), or ~two
 *     months for utilities (52–70). Any two charges less than 20 days apart
 *     make it a repeat merchant: rejected, unless one tight amount cluster
 *     (±3 %, ≥ 3 charges, e.g. iCloud inside a busy "APPLE.COM/BILL") still
 *     behaves like a subscription on its own.
 *  2. Day — the day of the month varies by at most ±4 (±6 for known
 *     subscription types, ±8 for utilities).
 *  3. Amount — within ±12 % month to month. A foreign-currency subscription
 *     with the same original amount passes whatever the exchange rate did.
 *     Utilities (electricity, water, gas, arnona) may vary up to ±50 %.
 *     One larger jump on the latest charge of an established series is a
 *     price change, not a different charge.
 *  4. Type — subscription keywords/categories (streaming, SaaS/AI, insurance,
 *     telecom, gym, municipal, utilities) add confidence; retail, food,
 *     supermarket, fuel, pharmacy and wallet top-ups are rejected outright.
 *  5. The user's own marking always wins, both ways.
 *
 * Months are billing months (see billingCycle.ts); the caller passes rows
 * with future charges already removed. Pure — also run by the server's tests.
 */

import { monthIndex, parseYmd } from "./billingCycle.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RecurringTx {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  amount: number;
  category: string;
  subCategory?: string;
  billingYear: number;
  billingMonth: number;
  source?: string;
  originalAmount?: number;
  originalCurrency?: string;
  installmentNumber?: number;
  installmentTotal?: number;
}

export type FixedKind = "subscription" | "standing-order" | "utility" | "installment" | "manual";

export type ChargeStatus =
  /** Charged in the viewed month. */
  | "charged"
  /** Due in the viewed month, not seen yet. */
  | "expected"
  /** A bi-monthly bill between two charges. */
  | "off-month";

export interface RecurringCharge {
  /** Unique within a result. */
  id: string;
  /** Normalised merchant name — what the user's fixed / not-fixed marking is keyed by. */
  key: string;
  description: string;
  /** The latest charge (or, when expected, the one before it). */
  amount: number;
  previousAmount: number | null;
  kind: FixedKind;
  /** Months between charges. */
  cadence: 1 | 2;
  /** amount / cadence — what it costs per month. */
  monthlyCost: number;
  /** Usual day of the month. */
  dayOfMonth: number;
  status: ChargeStatus;
  /** Charges found in the look-back window. */
  occurrences: number;
  /** Set for a foreign-currency subscription. */
  original?: { amount: number; currency: string };
  /** Installment plans only. */
  installment?: { number: number; total: number };
  /** The user marked this merchant as fixed. */
  userMarked: boolean;
}

export interface RecurringAlert {
  kind: "amount-changed" | "stopped" | "new";
  key: string;
  description: string;
  /** Only for "amount-changed". */
  previousAmount?: number;
  currentAmount?: number;
  diff?: number;
}

export interface RecurringResult {
  charges: RecurringCharge[];
  alerts: RecurringAlert[];
  /** Sum of monthlyCost — the user's fixed monthly commitments. */
  monthlyTotal: number;
}

export interface RecurringOptions {
  /** Merchant keys the user marked as fixed. */
  fixed?: ReadonlySet<string>;
  /** Merchant keys the user marked as NOT fixed. */
  notFixed?: ReadonlySet<string>;
  /** Categories left out of the totals (internal transfers). */
  excludedCategories?: ReadonlySet<string>;
  /** YYYY-MM-DD; a charge due later than this is "expected", not "stopped". */
  today?: string;
}

// ── Thresholds ───────────────────────────────────────────────────────

const INCOME_CATEGORY = "מקורות הכנסה";

/** Billing months looked back from the viewed month. */
const LOOKBACK_MONTHS = 7;
const MAX_SERIES = 6;

/** Two charges closer than this are separate visits, not one bill. */
const MIN_GAP_DAYS = 20;
const MONTHLY_GAP: readonly [number, number] = [24, 38];
const BIMONTHLY_GAP: readonly [number, number] = [52, 70];

const AMOUNT_TOLERANCE = 0.12;
const TIGHT_AMOUNT_TOLERANCE = 0.08;
const UTILITY_AMOUNT_TOLERANCE = 0.5;
/** Inside a repeat merchant only a near-identical amount counts. */
const CLUSTER_AMOUNT_TOLERANCE = 0.03;
/** Same foreign price, different exchange rate: the shekel amount may drift this far. */
const FX_DRIFT_LIMIT = 0.25;
/** A jump on the latest charge up to this size is still the same bill, repriced. */
const PRICE_JUMP_LIMIT = 0.6;

const DAY_TOLERANCE = 4;
const HINTED_DAY_TOLERANCE = 6;
const UTILITY_DAY_TOLERANCE = 8;

/** Month-over-month increase that surfaces as a price alert (strictly more). */
const PRICE_INCREASE_THRESHOLD = 0.1;
const MIN_PRICE_INCREASE_ILS = 3;

/** Days after the expected date before a missing charge counts as stopped. */
const STOPPED_GRACE_DAYS = 7;

const MIN_SCORE = 4;

// ── Merchant type hints ──────────────────────────────────────────────

type Hint = "utility" | "positive" | "negative" | "neutral";

/** A Hebrew word on its own — JS `\b` only knows ASCII letters. */
const he = (word: string) => `(?<![א-ת])(?:${word})(?![א-ת])`;

const UTILITY_PATTERNS: RegExp[] = [
  /חברת\s*ה?חשמל|חח["״]?י|אלקטרה\s*פאוור|חשמל\s*(מהבית|לישראל)/,
  new RegExp(`תאגיד\\s*מים|${he("מי")}\\s+[א-ת]{3,}|${he("מים")}`),
  /ארנונה|עיריי?ת|עירית|מועצה\s+(מקומית|אזורית)/,
  new RegExp(`אמישראגז|פזגז|סופרגז|דורגז|${he("גז")}`),
];

/** Explicit subscription markers — these beat a retail name ("WOLT PLUS", "AMAZON PRIME"). */
const SUBSCRIPTION_MARKER = /\b(plus|premium|prime|subscription|membership)\b|\+\s*$|מנוי|הוראת\s*קבע|הו["״]ק|דמי\s*חבר/i;

/** Telecom brands that share a name with a shop. */
const POSITIVE_BEFORE_NEGATIVE = /רמי\s*לוי\s*(תקשורת|מובייל)/;

const POSITIVE_PATTERNS: RegExp[] = [
  // Streaming & media
  /netflix|נטפליקס|spotify|ספוטיפי|disney|דיסני|youtube|hbo|apple\.com\/bill|apple\s*(tv|music|one)|deezer|audible|kindle|\byes\b|\bhot\b|סלקום\s*tv|partner\s*tv|sting|סטינג/i,
  // SaaS / AI / cloud
  /openai|chatgpt|claude|anthropic|google\s*(one|storage|workspace|cloud)|icloud|microsoft|office\s*365|adobe|dropbox|github|notion|canva|cursor|midjourney|zoom|linkedin|patreon|1password|nordvpn|expressvpn|wix|godaddy|namecheap|cloudflare|\baws\b|digitalocean|perplexity|gemini|copilot/i,
  // Insurance, pension, health funds
  /ביטוח|הראל|מגדל|מנורה|הפניקס|איילון|הכשרה|\baig\b|ליברה|שירביט|פנסיה|קרן\s*השתלמות|קופת\s*גמל|מכבי|כללית|מאוחדת|לאומית\s*שירותי/i,
  // Telecom & internet
  /סלקום|cellcom|פרטנר|partner|פלאפון|pelephone|הוט\s*מובייל|hot\s*mobile|גולן\s*טלקום|golan|בזק|bezeq|\b01[2-9]\b|we4g|אקספון|xphone|triple\s*c|סיבים/i,
  // Gym & classes
  /הולמס|holmes|מכון\s*כושר|חדר\s*כושר|גו\s*אקטיב|go\s*active|icon\s*fitness|פילאטיס|יוגה|קאנטרי|חוגים?/i,
  // Housing, loans, education, donations
  /משכנתא|שכר\s*דירה|שכירות|ועד\s*בית|הלוואה|צהרון|גן\s*ילדים|מעון|שכר\s*לימוד|אוניברסיט|מכללת|עמותת|תרומה/i,
];

const NEGATIVE_PATTERNS: RegExp[] = [
  // Supermarkets & groceries
  new RegExp(
    `שופרסל|רמי\\s*לוי|ויקטורי|יוחננוף|אושר\\s*עד|טיב\\s*טעם|יינות\\s*ביתן|${he("מגה")}|חצי\\s*חינם|am\\s*:?\\s*pm|סופר|מרקט|מכולת|מעדני|קצביי?ה|ירקות|פירות|מאפ`,
    "i",
  ),
  // Restaurants, cafés, delivery
  /קפה|ארומה|aroma|cofix|קופיקס|לנדוור|רולדין|מסעד|פיצה|pizza|בורגר|burger|מקדונלד|mcdonald|סושי|שווארמה|פלאפל|חומוס|ביסטרו|wolt|וולט|תן\s*ביס|10\s*ביס|cibus|סיבוס|mishloha|משלוחה|גלידה/i,
  // Fuel, parking, rides
  new RegExp(
    `${he("פז")}|דלק|סונול|דור\\s*אלון|\\bten\\b|yellow|דלקן|פנגו|pango|סלופארק|cellopark|gett|yango|רב\\s*קו|moovit|חניון|חניה`,
    "i",
  ),
  // Pharmacy & retail
  /סופר\s*פארם|super\s*pharm|ניו\s*פארם|amazon|אמזון|aliexpress|shein|temu|ebay|zara|h&m|\bfox\b|קסטרו|castro|ikea|איקאה|\bace\b|הום\s*סנטר|\bksp\b|ivory|\bzap\b/i,
  // Wallet reloads & payment apps — their monthly sums only look regular.
  new RegExp(`${he("חבר")}|upapp|paybox|פייבוקס|\\bbit\\b|${he("ביט")}|נטען|טעינ`, "i"),
];

const POSITIVE_CATEGORY = /ביטוח|מנוי|תקשורת|סלולר|אינטרנט|טלפון|ועד\s*בית|משכנתא|שכ"ד|הלוואה|חסכונות|פנסיה|קרן\s*השתלמות|קופת|חוגים|גן\s*ילדים|שכר\s*לימוד|דמי\s*ניהול|ליסינג/;
const UTILITY_CATEGORY = new RegExp(`ארנונה|חשמל|${he("גז")}|${he("מים")}`);
const NEGATIVE_CATEGORY = /סופרמרקט|מסעד|קפה|wolt|דלק|ביגוד|הנעלה|אביזרים|טיפוח|ניקיון|תרופות|חניה|תחבורה\s*ציבורית|בילוי|חופש|מתנות|כלבו|חד\s*פעמי/i;

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/** What the merchant's name and category say about it. The name beats the category. */
export function merchantHint(description: string, category = "", subCategory = ""): Hint {
  if (matches(UTILITY_PATTERNS, description)) return "utility";
  if (SUBSCRIPTION_MARKER.test(description) || POSITIVE_BEFORE_NEGATIVE.test(description)) return "positive";
  if (matches(NEGATIVE_PATTERNS, description)) return "negative";
  if (matches(POSITIVE_PATTERNS, description)) return "positive";
  // The sub-category is the specific one: "פנאי ובידור / מנויים" is a subscription.
  if (UTILITY_CATEGORY.test(subCategory)) return "utility";
  if (POSITIVE_CATEGORY.test(subCategory)) return "positive";
  if (NEGATIVE_CATEGORY.test(subCategory)) return "negative";
  if (POSITIVE_CATEGORY.test(category)) return "positive";
  if (NEGATIVE_CATEGORY.test(category)) return "negative";
  return "neutral";
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Normalised merchant name: case, spacing and quote marks are ignored. */
export function merchantKey(description: string): string {
  return description
    .normalize("NFKC")
    .replace(/["'״׳`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isForeign(currency: string | undefined): currency is string {
  if (!currency) return false;
  const c = currency.trim().toUpperCase();
  return c !== "" && c !== "ILS" && c !== "NIS" && c !== "₪";
}

interface Occurrence {
  /** Days since the epoch — for gaps between charges. */
  day: number;
  /** Day of the month. */
  dom: number;
  /** Billing month index. */
  idx: number;
  amount: number;
  original?: { amount: number; currency: string };
  tx: RecurringTx;
}

function toOccurrence(tx: RecurringTx): Occurrence {
  const [y, m, d] = parseYmd(tx.date);
  return {
    day: Math.round(Date.UTC(y, m - 1, d) / 86_400_000),
    dom: d,
    idx: monthIndex(tx.billingYear, tx.billingMonth),
    amount: tx.amount,
    ...(isForeign(tx.originalCurrency) &&
      typeof tx.originalAmount === "number" &&
      tx.originalAmount > 0 && {
        original: { amount: tx.originalAmount, currency: tx.originalCurrency.trim().toUpperCase() },
      }),
    tx,
  };
}

const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b);

/** Same foreign price on both charges. */
function sameOriginal(a: Occurrence, b: Occurrence): boolean {
  return (
    !!a.original &&
    !!b.original &&
    a.original.currency === b.original.currency &&
    relDiff(a.original.amount, b.original.amount) <= 0.005
  );
}

/** Amount difference between two charges; ~0 for the same foreign price at a different rate. */
function amountDiff(a: Occurrence, b: Occurrence): number {
  const rel = relDiff(a.amount, b.amount);
  return sameOriginal(a, b) && rel <= FX_DRIFT_LIMIT ? 0 : rel;
}

/** Distance between two days of the month, wrapping around the month end (31 ↔ 1). */
function domDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 31 - d);
}

/** The day that the others stay closest to, and how far the furthest one is. */
function daySpread(doms: number[]): { center: number; deviation: number } {
  let best = { center: doms[0], deviation: Infinity };
  for (const center of doms) {
    const deviation = Math.max(...doms.map((d) => domDistance(d, center)));
    if (deviation < best.deviation) best = { center, deviation };
  }
  return best;
}

const within = (n: number, [lo, hi]: readonly [number, number]) => n >= lo && n <= hi;

interface Series {
  occurrences: Occurrence[];
  /** Number of charges before trimming to MAX_SERIES. */
  total: number;
  cadence: 1 | 2;
  hint: Hint;
  dayOfMonth: number;
}

/**
 * Decides whether a merchant's charges (oldest first) form one fixed charge.
 * `strict` is for an amount cluster inside a repeat merchant.
 */
function evaluateSeries(all: Occurrence[], strict: boolean): Series | null {
  const occurrences = all.slice(-MAX_SERIES);
  const n = occurrences.length;
  if (n < (strict ? 3 : 2)) return null;

  const latest = occurrences[n - 1];
  const hint = merchantHint(latest.tx.description, latest.tx.category, latest.tx.subCategory);
  if (hint === "negative") return null;
  const hinted = hint === "positive" || hint === "utility";

  // 1. Frequency
  const gaps = occurrences.slice(1).map((o, i) => o.day - occurrences[i].day);
  let cadence: 1 | 2;
  if (gaps.every((g) => within(g, MONTHLY_GAP))) cadence = 1;
  else if (gaps.every((g) => within(g, BIMONTHLY_GAP))) cadence = 2;
  else return null;
  // Two charges two months apart prove little on their own.
  if (cadence === 2 && n < 3 && !hinted) return null;

  // 2. Day of the month
  const { center, deviation } = daySpread(occurrences.map((o) => o.dom));
  const dayLimit = hint === "utility" ? UTILITY_DAY_TOLERANCE : hinted ? HINTED_DAY_TOLERANCE : DAY_TOLERANCE;
  if (deviation > dayLimit) return null;

  // 3. Amount
  const tolerance = strict ? CLUSTER_AMOUNT_TOLERANCE : hint === "utility" ? UTILITY_AMOUNT_TOLERANCE : AMOUNT_TOLERANCE;
  const diffs = occurrences.slice(1).map((o, i) => amountDiff(occurrences[i], o));
  const lastDiff = diffs[diffs.length - 1];
  const earlier = diffs.slice(0, -1);
  const repriced = !strict && n >= 3 && lastDiff > tolerance && lastDiff <= PRICE_JUMP_LIMIT && earlier.every((d) => d <= tolerance);
  if (!repriced && diffs.some((d) => d > tolerance)) return null;
  const worst = Math.max(0, ...(repriced ? earlier : diffs));

  // 4. Confidence
  const score =
    (n >= 4 ? 3 : n === 3 ? 2 : 1) +
    (deviation <= 2 ? 2 : deviation <= DAY_TOLERANCE ? 1 : 0) +
    (worst <= TIGHT_AMOUNT_TOLERANCE ? 2 : worst <= AMOUNT_TOLERANCE ? 1 : 0) +
    (hinted ? 2 : 0);
  if (score < MIN_SCORE) return null;

  return { occurrences, total: all.length, cadence, hint, dayOfMonth: center };
}

/**
 * Splits a repeat merchant's charges into groups of (nearly) the same price:
 * the same foreign price, or shekel amounts within CLUSTER_AMOUNT_TOLERANCE.
 */
function clusterByAmount(occurrences: Occurrence[]): Occurrence[][] {
  const foreign = new Map<string, Occurrence[]>();
  const local: Occurrence[] = [];
  for (const o of occurrences) {
    if (!o.original) {
      local.push(o);
      continue;
    }
    const key = `${o.original.currency}|${Math.round(o.original.amount * 100)}`;
    foreign.set(key, [...(foreign.get(key) ?? []), o]);
  }
  const clusters = [...foreign.values()];
  let current: Occurrence[] = [];
  for (const o of [...local].sort((a, b) => a.amount - b.amount)) {
    if (current.length && relDiff(current[0].amount, o.amount) > CLUSTER_AMOUNT_TOLERANCE) {
      clusters.push(current);
      current = [];
    }
    current.push(o);
  }
  if (current.length) clusters.push(current);
  return clusters.map((c) => c.sort((a, b) => a.day - b.day));
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * The fixed charges of billing month `year`/`month`, and what changed in them.
 * `transactions` is the user's history with future charges already removed.
 */
export function detectRecurring(
  transactions: readonly RecurringTx[],
  year: number,
  month: number,
  options: RecurringOptions = {},
): RecurringResult {
  const { fixed, notFixed, excludedCategories, today } = options;
  const M = monthIndex(year, month);
  const [ty, tm, td] = today ? parseYmd(today) : [year, month, 31];
  const todayIdx = monthIndex(ty, tm);
  const todayDay = Math.round(Date.UTC(ty, tm - 1, td) / 86_400_000);

  /** Earliest month with any data: a charge first seen there is not "new", the history just starts. */
  let dataStart = Infinity;
  const merchants = new Map<string, Occurrence[]>();
  const installments = new Map<string, Occurrence[]>();
  for (const tx of transactions) {
    if (tx.amount <= 0 || tx.category === INCOME_CATEGORY) continue;
    if (tx.category && excludedCategories?.has(tx.category)) continue;
    const key = merchantKey(tx.description);
    if (!key || notFixed?.has(key)) continue;
    const occ = toOccurrence(tx);
    dataStart = Math.min(dataStart, occ.idx);
    if (occ.idx > M || occ.idx < M - LOOKBACK_MONTHS) continue;

    if ((tx.installmentTotal ?? 0) > 1) {
      // Every payment of one plan carries the purchase date, so it is its own key.
      const planKey = `${key}|${tx.date}|${tx.installmentTotal}`;
      installments.set(planKey, [...(installments.get(planKey) ?? []), occ]);
    } else {
      merchants.set(key, [...(merchants.get(key) ?? []), occ]);
    }
  }

  const charges: RecurringCharge[] = [];
  const alerts: RecurringAlert[] = [];
  const monthOpen = M >= todayIdx;

  // ── Installment plans: fixed by definition until the last payment ──
  for (const [planKey, occs] of installments) {
    const latest = occs.reduce((a, b) => (b.idx > a.idx ? b : a));
    const number = latest.tx.installmentNumber ?? 0;
    const total = latest.tx.installmentTotal!;
    const charged = latest.idx === M;
    const due = latest.idx === M - 1 && number < total && monthOpen;
    if (!charged && !due) continue;
    charges.push({
      id: planKey,
      key: merchantKey(latest.tx.description),
      description: latest.tx.description.trim(),
      amount: latest.amount,
      previousAmount: null,
      kind: "installment",
      cadence: 1,
      monthlyCost: latest.amount,
      dayOfMonth: latest.dom,
      status: charged ? "charged" : "expected",
      occurrences: occs.length,
      installment: { number: charged ? number : number + 1, total },
      userMarked: false,
    });
  }

  // ── Everything else ───────────────────────────────────────────────
  for (const [key, unsorted] of merchants) {
    const occs = [...unsorted].sort((a, b) => a.day - b.day);
    const userMarked = fixed?.has(key) ?? false;
    const repeat = occs.some((o, i) => i > 0 && o.day - occs[i - 1].day < MIN_GAP_DAYS);
    const accepted = (repeat ? clusterByAmount(occs).map((c) => evaluateSeries(c, true)) : [evaluateSeries(occs, false)]).filter(
      (s): s is Series => s !== null,
    );

    let listed = 0;
    for (const series of accepted) {
      const n = series.occurrences.length;
      const last = series.occurrences[n - 1];
      const prev = series.occurrences[n - 2];
      const monthsSince = M - last.idx;
      const description = last.tx.description.trim();

      let status: ChargeStatus;
      if (monthsSince === 0) status = "charged";
      else if (series.cadence === 2 && monthsSince === 1) status = "off-month";
      else if (monthsSince === series.cadence) {
        const expectedDay = last.day + (series.cadence === 1 ? 30 : 61);
        const stillDue = M > todayIdx || (M === todayIdx && todayDay <= expectedDay + STOPPED_GRACE_DAYS);
        if (!stillDue) {
          alerts.push({ kind: "stopped", key, description });
          continue;
        }
        status = "expected";
      } else continue;

      listed++;
      charges.push({
        id: accepted.length > 1 ? `${key}|${Math.round(last.amount * 100)}` : key,
        key,
        description,
        amount: last.amount,
        previousAmount: prev.amount,
        kind: series.hint === "utility" ? "utility" : last.tx.source === "bank" ? "standing-order" : "subscription",
        cadence: series.cadence,
        monthlyCost: last.amount / series.cadence,
        dayOfMonth: series.dayOfMonth,
        status,
        occurrences: series.total,
        ...(last.original && { original: last.original }),
        userMarked,
      });

      if (status !== "charged") continue;
      if (series.total === 2) {
        if (series.occurrences[0].idx > dataStart) alerts.push({ kind: "new", key, description });
      } else if (series.hint !== "utility" && !sameOriginal(prev, last)) {
        const increase = last.amount - prev.amount;
        if (increase / prev.amount > PRICE_INCREASE_THRESHOLD && increase >= MIN_PRICE_INCREASE_ILS) {
          alerts.push({
            kind: "amount-changed",
            key,
            description,
            previousAmount: Math.round(prev.amount),
            currentAmount: Math.round(last.amount),
            diff: Math.round(increase),
          });
        }
      }
    }

    // The user said it is fixed: list it even though the rules disagree.
    if (userMarked && listed === 0) {
      const sumOf = (idx: number) => occs.filter((o) => o.idx === idx).reduce((s, o) => s + o.amount, 0);
      const thisMonth = sumOf(M);
      const lastMonth = sumOf(M - 1);
      if (thisMonth > 0 || (lastMonth > 0 && monthOpen)) {
        const latest = occs[occs.length - 1];
        charges.push({
          id: key,
          key,
          description: latest.tx.description.trim(),
          amount: thisMonth || lastMonth,
          previousAmount: thisMonth > 0 && lastMonth > 0 ? lastMonth : null,
          kind: "manual",
          cadence: 1,
          monthlyCost: thisMonth || lastMonth,
          dayOfMonth: latest.dom,
          status: thisMonth > 0 ? "charged" : "expected",
          occurrences: occs.length,
          userMarked: true,
        });
      }
    }
  }

  charges.sort((a, b) => b.monthlyCost - a.monthlyCost);
  const monthlyTotal = charges.reduce((sum, c) => sum + c.monthlyCost, 0);
  return { charges, alerts, monthlyTotal };
}

export const FIXED_KIND_LABELS: Record<FixedKind, string> = {
  subscription: "מנוי",
  "standing-order": "הוראת קבע",
  utility: "חשבון שוטף",
  installment: "תשלומים",
  manual: "סומן ידנית",
};
