/**
 * Monthly insights ("תובנות").
 *
 * Every comparison is like-for-like:
 *  - months are billing months, and the caller passes history with future
 *    charges already removed (see billingCycle.ts);
 *  - while the viewed month is still running, earlier months are cut at the
 *    same day of the month (card cycles are closed before the month starts, so
 *    only bank rows are cut) — a partial month is never held against a full one.
 *
 * Only insights the user can act on are produced, at most MAX_INSIGHTS:
 * spending pace, unusual category spikes (with the merchant that drove them),
 * fixed charges that are new or got more expensive, the biggest discretionary
 * spending driver, and rows waiting to be categorised.
 *
 * Pure — also run by the server's tests.
 */

import { comparableToDate, cycleIndex, fromMonthIndex, monthIndex, parseYmd } from "./billingCycle.js";
import { merchantKey, type RecurringResult } from "./recurringBills.js";

export interface InsightTx {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  amount: number;
  category: string;
  billingYear: number;
  billingMonth: number;
  source?: string;
}

export type InsightType = "warning" | "info" | "positive";

export interface Insight {
  id: string;
  type: InsightType;
  emoji: string;
  text: string;
  /** "categorize" → the card offers a button that opens the uncategorised rows. */
  action?: "categorize";
}

export interface InsightInput {
  /** All months, future charges removed. */
  history: readonly InsightTx[];
  year: number;
  month: number;
  /** YYYY-MM-DD */
  today: string;
  /** Categories left out of the totals (internal transfers). */
  excludedCategories: ReadonlySet<string>;
  recurring: Pick<RecurringResult, "charges" | "alerts">;
}

export const MAX_INSIGHTS = 4;

const INCOME_CATEGORY = "מקורות הכנסה";
const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

/** Months the viewed month is compared with. */
const BASELINE_MONTHS = 3;
const BASELINE_LOOKBACK = 6;

/** Too early in the month for a pace to mean anything. */
const MIN_PACE_DAY = 4;
const PACE_MIN_PCT = 0.1;
const PACE_MIN_ILS = 200;

const SPIKE_RATIO = 1.3;
const DROP_RATIO = 0.75;
const CATEGORY_MIN_ILS = 150;
const MAX_SPIKES = 2;

const DRIVER_MIN_SHARE = 0.12;
const DRIVER_MIN_ILS = 300;

const MIN_UNCATEGORIZED = 3;

const fmt = (n: number) => Math.round(n).toLocaleString("he-IL");
const pct = (ratio: number) => Math.round(Math.abs(ratio) * 100);
const sum = (rows: readonly InsightTx[]) => rows.reduce((s, r) => s + r.amount, 0);

function monthName(index: number): string {
  return MONTH_NAMES[fromMonthIndex(index)[1] - 1];
}

function totalsBy(rows: readonly InsightTx[], keyOf: (r: InsightTx) => string): Map<string, { total: number; count: number; label: string }> {
  const map = new Map<string, { total: number; count: number; label: string }>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const entry = map.get(key) ?? { total: 0, count: 0, label: r.description.trim() };
    entry.total += r.amount;
    entry.count++;
    map.set(key, entry);
  }
  return map;
}

export function buildInsights(input: InsightInput): Insight[] {
  const { history, year, month, today, excludedCategories, recurring } = input;
  const M = monthIndex(year, month);
  const [ty, tm, td] = parseYmd(today);
  const todayIdx = monthIndex(ty, tm);
  // A month that hasn't started has nothing to say yet.
  if (M > todayIdx) return [];
  const running = M === todayIdx;

  // Real spending only: no income rows, no internal transfers.
  const byMonth = new Map<number, InsightTx[]>();
  for (const tx of history) {
    if (tx.category === INCOME_CATEGORY) continue;
    if (tx.category && excludedCategories.has(tx.category)) continue;
    const idx = cycleIndex(tx);
    if (idx > M || idx < M - BASELINE_LOOKBACK) continue;
    byMonth.set(idx, [...(byMonth.get(idx) ?? []), tx]);
  }

  const current = byMonth.get(M) ?? [];
  if (current.length === 0) return [];
  /** An earlier month, cut at today's day while the viewed month is running. */
  const comparable = (idx: number) => {
    const rows = byMonth.get(idx) ?? [];
    return running ? rows.filter((r) => comparableToDate(r, td)) : rows;
  };
  const baseline: number[] = [];
  for (let idx = M - 1; idx >= M - BASELINE_LOOKBACK && baseline.length < BASELINE_MONTHS; idx--) {
    if (byMonth.has(idx)) baseline.push(idx);
  }

  const warnings: Insight[] = [];
  const infos: Insight[] = [];
  const positives: Insight[] = [];
  const curTotal = sum(current);

  // ── 1. Pace ───────────────────────────────────────────────────────
  if (running) {
    const prevIdx = M - 1;
    if (byMonth.has(prevIdx) && td >= MIN_PACE_DAY) {
      const prevToDate = sum(comparable(prevIdx));
      const prevFull = sum(byMonth.get(prevIdx)!);
      const diff = curTotal - prevToDate;
      if (prevToDate > 0 && Math.abs(diff) >= PACE_MIN_ILS && Math.abs(diff) / prevToDate >= PACE_MIN_PCT) {
        // What is still to come, judging by how last month continued from this day.
        const projected = curTotal + Math.max(prevFull - prevToDate, 0);
        const up = diff > 0;
        (up ? warnings : positives).push({
          id: "pace",
          type: up ? "warning" : "positive",
          emoji: up ? "📈" : "📉",
          text:
            `עד ה-${td} בחודש יצאו ${fmt(curTotal)} ₪ — ${pct(diff / prevToDate)}% ${up ? "יותר" : "פחות"} ` +
            `מאשר עד אותו יום ב${monthName(prevIdx)} (${fmt(prevToDate)} ₪). ` +
            `בקצב הזה החודש יסתיים סביב ${fmt(projected)} ₪.`,
        });
      }
    }
  } else if (baseline.length >= 2) {
    const typical = baseline.reduce((s, idx) => s + sum(byMonth.get(idx)!), 0) / baseline.length;
    const diff = curTotal - typical;
    if (typical > 0 && Math.abs(diff) >= PACE_MIN_ILS && Math.abs(diff) / typical >= PACE_MIN_PCT) {
      const up = diff > 0;
      (up ? warnings : positives).push({
        id: "month-total",
        type: up ? "warning" : "positive",
        emoji: up ? "📈" : "🎉",
        text:
          `ב${monthName(M)} יצאו ${fmt(curTotal)} ₪ — ${pct(diff / typical)}% ${up ? "יותר" : "פחות"} ` +
          `מהממוצע של ${baseline.length} החודשים שלפניו (${fmt(typical)} ₪).`,
      });
    }
  }

  // ── 2. Category spikes and drops ──────────────────────────────────
  if (baseline.length >= 2) {
    const curByCat = totalsBy(current, (r) => r.category);
    const baseByCat = new Map<string, number>();
    for (const idx of baseline) {
      for (const [cat, { total }] of totalsBy(comparable(idx), (r) => r.category)) {
        baseByCat.set(cat, (baseByCat.get(cat) ?? 0) + total / baseline.length);
      }
    }

    const spikes: { cat: string; spent: number; typical: number }[] = [];
    const drops: { cat: string; spent: number; typical: number }[] = [];
    for (const [cat, typical] of baseByCat) {
      if (typical <= 0) continue;
      const spent = curByCat.get(cat)?.total ?? 0;
      if (spent >= typical * SPIKE_RATIO && spent - typical >= CATEGORY_MIN_ILS) spikes.push({ cat, spent, typical });
      // A drop is only real once the month is over.
      else if (!running && spent > 0 && spent <= typical * DROP_RATIO && typical - spent >= CATEGORY_MIN_ILS) {
        drops.push({ cat, spent, typical });
      }
    }

    spikes.sort((a, b) => b.spent - b.typical - (a.spent - a.typical));
    for (const { cat, spent, typical } of spikes.slice(0, MAX_SPIKES)) {
      const merchants = [...totalsBy(current.filter((r) => r.category === cat), (r) => merchantKey(r.description)).values()];
      const top = merchants.sort((a, b) => b.total - a.total)[0];
      const driver = top && top.total >= spent * 0.3 ? ` בעיקר ${top.label} (${fmt(top.total)} ₪).` : "";
      warnings.push({
        id: `spike-${cat}`,
        type: "warning",
        emoji: "⚠️",
        text:
          `${cat}: ${fmt(spent)} ₪ — ${fmt(spent - typical)} ₪ מעל הרגיל` +
          `${running ? " לשלב הזה בחודש" : ""} (${fmt(typical)} ₪).${driver}`,
      });
    }

    drops.sort((a, b) => b.typical - b.spent - (a.typical - a.spent));
    const drop = drops[0];
    if (drop) {
      positives.push({
        id: `drop-${drop.cat}`,
        type: "positive",
        emoji: "🎉",
        text: `${drop.cat}: ${fmt(drop.spent)} ₪ — ${pct((drop.typical - drop.spent) / drop.typical)}% פחות מהרגיל (${fmt(drop.typical)} ₪).`,
      });
    }
  }

  // ── 3. Fixed charges: price increases and new ones ────────────────
  const increases = recurring.alerts.filter((a) => a.kind === "amount-changed");
  for (const a of increases.slice(0, 2)) {
    warnings.unshift({
      id: `price-${a.key}`,
      type: "warning",
      emoji: "💸",
      text:
        `${a.description} התייקר ב-${fmt(a.diff ?? 0)} ₪ (מ-${fmt(a.previousAmount ?? 0)} ל-${fmt(a.currentAmount ?? 0)} ₪) — ` +
        `${fmt((a.diff ?? 0) * 12)} ₪ בשנה. שווה לבדוק מול הספק.`,
    });
  }
  const fresh = recurring.alerts.filter((a) => a.kind === "new");
  if (fresh.length > 0) {
    const costOf = (key: string) => recurring.charges.find((c) => c.key === key)?.monthlyCost ?? 0;
    const total = fresh.reduce((s, a) => s + costOf(a.key), 0);
    const names = fresh.slice(0, 2).map((a) => a.description).join(", ") + (fresh.length > 2 ? ` ועוד ${fresh.length - 2}` : "");
    infos.push({
      id: "new-fixed",
      type: "info",
      emoji: "🔁",
      text:
        fresh.length === 1
          ? `זוהה חיוב קבוע חדש: ${names} — ${fmt(total)} ₪ בחודש, ${fmt(total * 12)} ₪ בשנה.`
          : `זוהו ${fresh.length} חיובים קבועים חדשים (${names}) — יחד ${fmt(total)} ₪ בחודש.`,
    });
  }

  // ── 4. The biggest discretionary driver ───────────────────────────
  const fixedKeys = new Set(recurring.charges.map((c) => c.key));
  const discretionary = current.filter((r) => r.amount > 0 && !fixedKeys.has(merchantKey(r.description)));
  const topMerchant = [...totalsBy(discretionary, (r) => merchantKey(r.description)).entries()].sort(
    (a, b) => b[1].total - a[1].total,
  )[0];
  if (topMerchant && curTotal > 0) {
    const [key, { total, count, label }] = topMerchant;
    if (count >= 2 && total >= DRIVER_MIN_ILS && total / curTotal >= DRIVER_MIN_SHARE) {
      const usual =
        baseline.reduce(
          (s, idx) => s + sum(comparable(idx).filter((r) => merchantKey(r.description) === key)),
          0,
        ) / Math.max(baseline.length, 1);
      const versus = usual > 0 && total >= usual * 1.25 ? ` — ${pct(total / usual - 1)}% מעל הרגיל אצלו` : "";
      infos.push({
        id: `driver-${key}`,
        type: "info",
        emoji: "🎯",
        text: `מוקד ההוצאה הגדול: ${label} — ${fmt(total)} ₪ ב-${count} עסקאות, ${pct(total / curTotal)}% מהוצאות החודש${versus}.`,
      });
    }
  }

  // ── 5. Rows waiting for a category ────────────────────────────────
  const uncategorized = current.filter((r) => !r.category);
  if (uncategorized.length >= MIN_UNCATEGORIZED) {
    infos.push({
      id: "uncategorized",
      type: "info",
      emoji: "💡",
      text: `${uncategorized.length} עסקאות (${fmt(sum(uncategorized))} ₪) עדיין ללא סיווג — הן לא נכנסות להשוואות לפי קטגוריה.`,
      action: "categorize",
    });
  }

  return [...warnings, ...infos, ...positives].slice(0, MAX_INSIGHTS);
}
