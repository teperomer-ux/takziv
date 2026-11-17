/**
 * Savings profile ("פרופיל חיסכון"): what the household keeps of what it
 * earns, how much of its spending is committed in advance, and a realistic
 * next step.
 *
 * Built only from COMPLETE months (the running month and future charges are
 * left out), and only from months that have both income and expenses — a month
 * whose income was never imported would otherwise read as a 100 % deficit.
 *
 *  - income:   operating income by calendar month, internal transfers excluded
 *  - expenses: billing-month spending (as on the dashboard) plus manual
 *              expenses, internal transfers excluded, refunds netted off
 *  - fixed:    the detected fixed charges' monthly cost (recurringBills.ts)
 *              plus the user's manual recurring expenses
 *
 * Pure — also run by the server's tests.
 */

import { cycleIndex, monthIndex, parseYmd } from "./billingCycle.js";
import { merchantKey } from "./recurringBills.js";

export interface ProfileExpense {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  amount: number;
  category: string;
  billingYear: number;
  billingMonth: number;
  source?: string;
}

export interface ProfileIncome {
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  category: string;
}

export interface SavingsProfileInput {
  /** All months, future charges removed. */
  expenses: readonly ProfileExpense[];
  incomes: readonly ProfileIncome[];
  excludedExpenseCategories: ReadonlySet<string>;
  excludedIncomeCategories: ReadonlySet<string>;
  /** Monthly cost of the detected fixed charges, with their merchant keys and names (largest first). */
  fixed: { monthlyTotal: number; charges: readonly { key: string; description: string; monthlyCost: number }[] };
  /** Manual expenses (one-off + recurring) for a month index. */
  manualExpensesFor?: (monthIdx: number) => number;
  /** Manual recurring expenses per month — part of the fixed costs. */
  manualFixedMonthly?: number;
  /** YYYY-MM-DD */
  today: string;
}

export type ProfileLevel = "excellent" | "good" | "fair" | "at-risk";

export interface SavingsProfile {
  /** "insufficient" until one complete month has both income and expenses. */
  status: "ok" | "insufficient";
  monthsUsed: number;
  /** Complete months left out because no income was recorded. */
  monthsMissingIncome: number;
  avgIncome: number;
  avgExpenses: number;
  /** avgIncome − avgExpenses; negative = deficit. */
  netSavings: number;
  /** netSavings / avgIncome, floored at −1. */
  savingsRate: number;
  fixedMonthly: number;
  variableMonthly: number;
  /** Share of spending that is fixed, 0–1. */
  fixedRatio: number;
  targetRate: number;
  /** Monthly savings at the target rate. */
  targetSavings: number;
  /** What is missing to reach the target; 0 when already there. */
  gap: number;
  /** A cut in variable spending that is realistic next month. */
  suggestedCut: number;
  /** 0–100. */
  score: number;
  level: ProfileLevel;
  /** Twelve months at the current pace (0 when in deficit). */
  projection12: number;
  /** Twelve months if the suggested cut is made. */
  projection12WithCut: number;
  tips: string[];
}

const INCOME_CATEGORY = "מקורות הכנסה";
export const TARGET_SAVINGS_RATE = 0.2;
/** Complete months the profile averages over. */
const PROFILE_MONTHS = 6;
const LOOKBACK_MONTHS = 12;
/** The most of the variable spending a single month's cut should ask for. */
const MAX_CUT_SHARE = 0.15;
const MAX_TIPS = 4;
const DEFICIT_SCORE_CAP = 35;

const fmt = (n: number) => Math.round(n).toLocaleString("he-IL");
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export const LEVEL_LABELS: Record<ProfileLevel, string> = {
  excellent: "מצוין",
  good: "טוב",
  fair: "דורש שיפור",
  "at-risk": "בסיכון",
};

const EMPTY: SavingsProfile = {
  status: "insufficient",
  monthsUsed: 0,
  monthsMissingIncome: 0,
  avgIncome: 0,
  avgExpenses: 0,
  netSavings: 0,
  savingsRate: 0,
  fixedMonthly: 0,
  variableMonthly: 0,
  fixedRatio: 0,
  targetRate: TARGET_SAVINGS_RATE,
  targetSavings: 0,
  gap: 0,
  suggestedCut: 0,
  score: 0,
  level: "at-risk",
  projection12: 0,
  projection12WithCut: 0,
  tips: [],
};

export function buildSavingsProfile(input: SavingsProfileInput): SavingsProfile {
  const { expenses, incomes, excludedExpenseCategories, excludedIncomeCategories, fixed, today } = input;
  const [ty, tm] = parseYmd(today);
  const todayIdx = monthIndex(ty, tm);
  const inWindow = (idx: number) => idx < todayIdx && idx >= todayIdx - LOOKBACK_MONTHS;

  // ── Monthly income and spending ───────────────────────────────────
  const incomeBy = new Map<number, number>();
  let incomeTotal = 0;
  let incomeUncategorized = 0;
  for (const row of incomes) {
    if (row.category && excludedIncomeCategories.has(row.category)) continue;
    const [y, m] = parseYmd(row.date);
    const idx = monthIndex(y, m);
    if (!inWindow(idx)) continue;
    incomeBy.set(idx, (incomeBy.get(idx) ?? 0) + row.amount);
    incomeTotal += row.amount;
    if (!row.category) incomeUncategorized += row.amount;
  }

  const spendBy = new Map<number, number>();
  const rowsBy = new Map<number, ProfileExpense[]>();
  for (const row of expenses) {
    if (row.category === INCOME_CATEGORY) continue;
    if (row.category && excludedExpenseCategories.has(row.category)) continue;
    const idx = cycleIndex(row);
    if (!inWindow(idx)) continue;
    spendBy.set(idx, (spendBy.get(idx) ?? 0) + row.amount);
    rowsBy.set(idx, [...(rowsBy.get(idx) ?? []), row]);
  }

  // ── Months that can be trusted: both sides present ────────────────
  const used: { idx: number; income: number; spent: number }[] = [];
  let monthsMissingIncome = 0;
  for (let idx = todayIdx - 1; idx >= todayIdx - LOOKBACK_MONTHS && used.length < PROFILE_MONTHS; idx--) {
    const income = incomeBy.get(idx) ?? 0;
    const spent = Math.max((spendBy.get(idx) ?? 0) + (input.manualExpensesFor?.(idx) ?? 0), 0);
    if (income <= 0 && spent <= 0) continue;
    if (income <= 0) {
      monthsMissingIncome++;
      continue;
    }
    // Income but no spending at all: the expenses were never imported.
    if (spent <= 0) continue;
    used.push({ idx, income, spent });
  }
  if (used.length === 0) return { ...EMPTY, monthsMissingIncome };

  const avgIncome = mean(used.map((m) => m.income));
  const avgExpenses = mean(used.map((m) => m.spent));
  const netSavings = avgIncome - avgExpenses;
  const savingsRate = Math.max(netSavings / avgIncome, -1);

  // ── Fixed vs. variable ────────────────────────────────────────────
  const fixedMonthly = Math.min(fixed.monthlyTotal + (input.manualFixedMonthly ?? 0), avgExpenses);
  const variableMonthly = avgExpenses - fixedMonthly;
  const fixedRatio = avgExpenses > 0 ? clamp01(fixedMonthly / avgExpenses) : 0;

  // ── Target ────────────────────────────────────────────────────────
  const targetSavings = avgIncome * TARGET_SAVINGS_RATE;
  const gap = Math.max(targetSavings - netSavings, 0);
  const rawCut = Math.min(gap, variableMonthly * MAX_CUT_SHARE);
  const suggestedCut = rawCut >= 50 ? roundTo(rawCut, 50) : Math.round(rawCut);

  // ── Score ─────────────────────────────────────────────────────────
  // 60 — savings rate (0 % → 0, target → full)
  // 20 — room to manoeuvre (fixed ≤ 50 % of spending → full, ≥ 80 % → 0)
  // 20 — stability of monthly spending (variation ≤ 10 % → full, ≥ 40 % → 0)
  const ratePoints = 60 * clamp01(savingsRate / TARGET_SAVINGS_RATE);
  const fixedPoints = 20 * clamp01((0.8 - fixedRatio) / 0.3);
  const spends = used.map((m) => m.spent);
  const variation =
    used.length >= 2 && avgExpenses > 0
      ? Math.sqrt(mean(spends.map((s) => (s - avgExpenses) ** 2))) / avgExpenses
      : null;
  // With a single month there is no variation to measure: the other parts are scaled up.
  const rawScore = Math.round(
    variation === null
      ? ((ratePoints + fixedPoints) / 80) * 100
      : ratePoints + fixedPoints + 20 * clamp01((0.4 - variation) / 0.3),
  );
  // Spending more than is earned is never better than "at risk", however steady it is.
  const score = netSavings < 0 ? Math.min(rawScore, DEFICIT_SCORE_CAP) : rawScore;
  const level: ProfileLevel = score >= 80 ? "excellent" : score >= 60 ? "good" : score >= 40 ? "fair" : "at-risk";

  // ── The largest variable category ─────────────────────────────────
  const fixedKeys = new Set(fixed.charges.map((c) => c.key));
  const byCategory = new Map<string, number>();
  for (const { idx } of used) {
    for (const row of rowsBy.get(idx) ?? []) {
      if (!row.category || fixedKeys.has(merchantKey(row.description))) continue;
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amount / used.length);
    }
  }
  const topVariable = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];

  // ── Tips ──────────────────────────────────────────────────────────
  const tips: string[] = [];
  if (netSavings < 0) {
    tips.push(
      `בממוצע יוצאים ${fmt(-netSavings)} ₪ בחודש יותר ממה שנכנס. היעד הראשון הוא איזון` +
        (suggestedCut > 0 ? ` — התחילו מקיצוץ של ${fmt(suggestedCut)} ₪ בהוצאות המשתנות בחודש הבא.` : "."),
    );
  } else if (gap > 0) {
    tips.push(
      `כדי לחסוך ${Math.round(TARGET_SAVINGS_RATE * 100)}% מההכנסה חסרים ${fmt(gap)} ₪ בחודש.` +
        (suggestedCut > 0
          ? ` יעד ריאלי לחודש הבא: ${fmt(suggestedCut)} ₪ פחות בהוצאות המשתנות (${Math.round((suggestedCut / Math.max(variableMonthly, 1)) * 100)}% מהן).`
          : ""),
    );
  } else {
    tips.push(
      `אתם חוסכים ${Math.round(savingsRate * 100)}% מההכנסה — מעל היעד. ` +
        `העברה אוטומטית של ${fmt(roundTo(netSavings * 0.8, 50))} ₪ לחיסכון בתחילת כל חודש תשמור על זה.`,
    );
  }
  if (fixedRatio >= 0.6 && fixed.charges.length > 0) {
    const names = fixed.charges.slice(0, 3).map((c) => c.description).join(", ");
    tips.push(
      `${Math.round(fixedRatio * 100)}% מההוצאות קבועות (${fmt(fixedMonthly)} ₪ בחודש). ` +
        `שם נמצא החיסכון הגדול: בדקו מחיר מול הספק ב-${names}.`,
    );
  }
  if (topVariable && topVariable[1] >= 300) {
    const [name, monthly] = topVariable;
    tips.push(
      `ההוצאה המשתנה הגדולה: ${name}, כ-${fmt(monthly)} ₪ בחודש. ` +
        `10% פחות שווים ${fmt(monthly * 0.1)} ₪ בחודש ו-${fmt(monthly * 1.2)} ₪ בשנה.`,
    );
  }
  if (monthsMissingIncome > 0) {
    tips.push(
      `${monthsMissingIncome === 1 ? "בחודש אחד" : `ב-${monthsMissingIncome} חודשים`} אין נתוני הכנסה, ולכן ` +
        `${monthsMissingIncome === 1 ? "הוא לא נכלל" : "הם לא נכללו"} בחישוב. סנכרון חשבון הבנק ישלים אותם.`,
    );
  }
  if (incomeTotal > 0 && incomeUncategorized / incomeTotal >= 0.2) {
    tips.push(
      `${Math.round((incomeUncategorized / incomeTotal) * 100)}% מההכנסות ללא סיווג. אם חלקן העברות בין החשבונות שלכם, ` +
        `שיעור החיסכון מוצג גבוה מדי — סווגו אותן כ"העברות פנימיות".`,
    );
  }
  if (variation !== null && variation >= 0.3) {
    tips.push(
      `ההוצאות משתנות ב-±${Math.round(variation * 100)}% מחודש לחודש. ` +
        `כרית ביטחון של שלושה חודשי הוצאות (${fmt(avgExpenses * 3)} ₪) תספוג חודש חריג.`,
    );
  }

  return {
    status: "ok",
    monthsUsed: used.length,
    monthsMissingIncome,
    avgIncome,
    avgExpenses,
    netSavings,
    savingsRate,
    fixedMonthly,
    variableMonthly,
    fixedRatio,
    targetRate: TARGET_SAVINGS_RATE,
    targetSavings,
    gap,
    suggestedCut,
    score,
    level,
    projection12: Math.max(netSavings, 0) * 12,
    projection12WithCut: Math.max(netSavings + suggestedCut, 0) * 12,
    tips: tips.slice(0, MAX_TIPS),
  };
}
