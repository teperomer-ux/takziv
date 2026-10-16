import type { Transaction } from "../types";

// ── Types ────────────────────────────────────────────────────────────

export interface RecurringCharge {
  description: string;
  amountM: number;   // amount in current month (M)
  amountM1: number;  // amount in previous month (M-1)
}

export interface RecurringAlert {
  kind: "amount-changed" | "stopped" | "new";
  description: string;
  /** Only present for "amount-changed" */
  previousAmount?: number;
  currentAmount?: number;
  diff?: number;
}

export interface RecurringResult {
  charges: RecurringCharge[];
  alerts: RecurringAlert[];
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Maximum month-over-month variance that still counts as the same recurring
 * bill. We deliberately widened this beyond the old 5 % cap so genuine price
 * creep (e.g. a 12 % gym hike, a 20 % insurance renewal) still registers as
 * the SAME charge — otherwise the price-increase alert below could never
 * fire, because anything past 5 % would be reclassified as "stopped".
 * Past 50 % the row is almost certainly a different transaction entirely.
 */
const MAX_VARIANCE = 0.50;

/**
 * Minimum month-over-month price increase that surfaces as an alert. Below
 * this we treat the delta as noise (CPI/index linking, mid-month billing-day
 * shift, fractional currency rounding) and stay silent.
 *
 * Comparison is strict: a 10 % increase exactly does NOT alert; only > 10 %
 * does. Decreases never alert — this is a "price creep" warning only.
 */
const PRICE_INCREASE_THRESHOLD = 0.10;

/**
 * Descriptions (partial matches) that should never be treated as recurring.
 * e.g. prepaid wallet reloads, top-up apps whose monthly sums coincidentally match.
 */
const IGNORED_RECURRING_NAMES = ["חבר", "UPAPP"];

/** Step one month back, handling year wrap. */
function prevMonth(y: number, m: number): [number, number] {
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}

function billingKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * Are two positive amounts within 5% of each other?
 * Divides by the SMALLER value so the percentage is always
 * calculated against the stricter baseline.
 */
function isPairRecurring(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.min(a, b) <= MAX_VARIANCE;
}

interface MonthBucket {
  sum: number;
  count: number;
}

/**
 * Group transactions by normalized description into per-billing-month buckets.
 * Each bucket tracks the total sum AND the number of individual transactions.
 * Uses billingYear / billingMonth — never the raw date string.
 * Skips income rows and blank descriptions.
 */
function groupByBillingMonth(
  txs: Transaction[],
): Map<string, Map<string, MonthBucket>> {
  const map = new Map<string, Map<string, MonthBucket>>();

  for (const tx of txs) {
    if (tx.category === "מקורות הכנסה") continue;
    const desc = tx.description.trim().replace(/\s+/g, " ");
    if (!desc) continue;

    const key = `${tx.billingYear}-${String(tx.billingMonth).padStart(2, "0")}`;

    let months = map.get(desc);
    if (!months) {
      months = new Map();
      map.set(desc, months);
    }
    const prev = months.get(key);
    months.set(key, {
      sum: (prev?.sum ?? 0) + tx.amount,
      count: (prev?.count ?? 0) + 1,
    });
  }

  return map;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Calculate the recurring charges list and alerts for month M.
 *
 * Pipeline (all based on billingMonth/billingYear):
 *
 * 1. For each description, look up amounts in M, M-1, M-2.
 * 2. Compute two booleans:
 *    - recurring_M_M1:  exists in M AND M-1 AND isPairRecurring(M, M-1)
 *    - recurring_M1_M2: exists in M-1 AND M-2 AND isPairRecurring(M-1, M-2)
 * 3. Map to output:
 *    - charges[]:        recurring_M_M1 === true
 *    - alert "new":      recurring_M_M1 === true  AND recurring_M1_M2 === false
 *    - alert "stopped":  recurring_M_M1 === false AND recurring_M1_M2 === true
 *    - alert "changed":  recurring_M_M1 === true  AND recurring_M1_M2 === true AND amountM !== amountM1
 */
export function calculateRecurringAndAlerts(
  allTransactions: Transaction[],
  year: number,
  month: number,
): RecurringResult {
  // Filter out blacklisted descriptions before any grouping/summing
  const filtered = allTransactions.filter(
    (tx) => !IGNORED_RECURRING_NAMES.some((bl) => tx.description.includes(bl)),
  );

  const byDesc = groupByBillingMonth(filtered);

  const keyM = billingKey(year, month);
  const [y1, m1] = prevMonth(year, month);
  const keyM1 = billingKey(y1, m1);
  const [y2, m2] = prevMonth(y1, m1);
  const keyM2 = billingKey(y2, m2);

  const charges: RecurringCharge[] = [];
  const alerts: RecurringAlert[] = [];

  for (const [desc, months] of byDesc) {
    const bucketM  = months.get(keyM);
    const bucketM1 = months.get(keyM1);
    const bucketM2 = months.get(keyM2);

    const amountM  = bucketM?.sum;
    const amountM1 = bucketM1?.sum;
    const amountM2 = bucketM2?.sum;

    // ── Frequency filter: real recurring bills appear exactly once ─
    // If a description has multiple transactions in M or M-1, it's a
    // variable expense (wallet reload, groceries, etc.), not a bill.
    const multiM  = (bucketM?.count ?? 0) > 1;
    const multiM1 = (bucketM1?.count ?? 0) > 1;

    // ── Two booleans — the entire decision tree ──────────────────
    const recurring_M_M1 =
      !multiM && !multiM1 &&
      amountM != null && amountM1 != null && isPairRecurring(amountM, amountM1);

    const multiM2 = (bucketM2?.count ?? 0) > 1;
    const recurring_M1_M2 =
      !multiM1 && !multiM2 &&
      amountM1 != null && amountM2 != null && isPairRecurring(amountM1, amountM2);

    // ── Map to output arrays ─────────────────────────────────────

    // If NOT recurring this month, it cannot be in charges / new / changed
    if (!recurring_M_M1) {
      // But it CAN be "stopped" if it was recurring last month
      if (recurring_M1_M2) {
        alerts.push({ kind: "stopped", description: desc });
      }
      continue; // nothing else to do for this description
    }

    // recurring_M_M1 is TRUE — add to charges list
    charges.push({
      description: desc,
      amountM: amountM!,
      amountM1: amountM1!,
    });

    if (!recurring_M1_M2) {
      // First time qualifying → NEW
      alerts.push({ kind: "new", description: desc });
    } else {
      // ── Price-creep gate ──────────────────────────────────────
      // The bill was already recurring last month AND still is this
      // month. Only emit an "amount-changed" alert when the price
      // genuinely went UP by strictly more than PRICE_INCREASE_THRESHOLD
      // (10 %). Anything at-or-below 10 % is treated as noise (CPI
      // linking, billing-day shift, rounding) and stays silent — those
      // are the false positives the user reported. Price *decreases*
      // never alert; this is a creep warning, not a change log.
      const previousAmount = amountM1!;
      const currentAmount = amountM!;
      const percentIncrease =
        previousAmount > 0
          ? (currentAmount - previousAmount) / previousAmount
          : 0;

      if (percentIncrease > PRICE_INCREASE_THRESHOLD) {
        alerts.push({
          kind: "amount-changed",
          description: desc,
          previousAmount: Math.round(previousAmount),
          currentAmount: Math.round(currentAmount),
          diff: Math.round(currentAmount - previousAmount),
        });
      }
    }
  }

  charges.sort((a, b) => b.amountM - a.amountM);
  return { charges, alerts };
}
