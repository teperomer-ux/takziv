import type { Transaction } from "../types";

export interface RecurringBill {
  description: string;
  avgAmount: number;
  typicalDay: number;
  monthCount: number;
}

export interface NewRecurringDetection {
  description: string;
  amount: number;
  typicalDay: number;
  months: [string, string]; // the two consecutive month keys
}

/** Check if two YYYY-MM strings are consecutive months. */
function areConsecutiveMonths(a: string, b: string): boolean {
  const [y1, m1] = a.split("-").map(Number);
  const [y2, m2] = b.split("-").map(Number);
  // a is the month before b
  if (y1 === y2 && m2 === m1 + 1) return true;
  // Dec → Jan cross-year
  if (y2 === y1 + 1 && m1 === 12 && m2 === 1) return true;
  return false;
}

/**
 * Detect businesses that appeared for exactly 2 consecutive months
 * for the first time ever — potential new subscriptions.
 */
export function detectNewRecurring(
  allTransactions: Transaction[],
  pinnedDescriptions: Set<string>
): NewRecurringDetection[] {
  const byDesc = new Map<
    string,
    { months: Map<string, { total: number; day: number }>; count: number }
  >();

  for (const tx of allTransactions) {
    if (tx.category === "מקורות הכנסה") continue;
    const desc = tx.description.trim();
    if (!desc) continue;

    let entry = byDesc.get(desc);
    if (!entry) {
      entry = { months: new Map(), count: 0 };
      byDesc.set(desc, entry);
    }

    const monthKey = tx.date.slice(0, 7);
    const existing = entry.months.get(monthKey);
    const day = parseInt(tx.date.slice(8, 10), 10);
    if (existing) {
      existing.total += tx.amount;
    } else {
      entry.months.set(monthKey, { total: tx.amount, day });
    }
    entry.count++;
  }

  const results: NewRecurringDetection[] = [];

  for (const [desc, data] of byDesc) {
    // Exactly 2 distinct months, exactly 2 transactions
    if (data.months.size !== 2 || data.count !== 2) continue;
    // Skip already-pinned bills
    if (pinnedDescriptions.has(desc)) continue;

    const keys = [...data.months.keys()].sort();
    if (!areConsecutiveMonths(keys[0], keys[1])) continue;

    const vals = [...data.months.values()];

    // Amounts must be within 20% of each other to count as recurring
    const minAmt = Math.min(Math.abs(vals[0].total), Math.abs(vals[1].total));
    if (minAmt > 0) {
      const diffPct = Math.abs(vals[0].total - vals[1].total) / minAmt;
      if (diffPct > 0.20) continue;
    }

    const avgAmount = (vals[0].total + vals[1].total) / 2;
    const typicalDay = Math.round((vals[0].day + vals[1].day) / 2);

    results.push({
      description: desc,
      amount: avgAmount,
      typicalDay,
      months: [keys[0], keys[1]],
    });
  }

  return results;
}

/**
 * Detect recurring bills from historical transactions.
 * Returns bills expected in the remaining days of the given month.
 */
export function computeUpcomingBills(
  allTransactions: Transaction[],
  year: number,
  month: number
): RecurringBill[] {
  const byDesc = new Map<
    string,
    { months: Set<string>; totalAmount: number; days: number[]; count: number }
  >();

  for (const tx of allTransactions) {
    if (tx.category === "מקורות הכנסה") continue;
    if (!tx.description.trim()) continue;

    const key = tx.description.trim();
    let entry = byDesc.get(key);
    if (!entry) {
      entry = { months: new Set(), totalAmount: 0, days: [], count: 0 };
      byDesc.set(key, entry);
    }

    const monthKey = tx.date.slice(0, 7);
    entry.months.add(monthKey);
    entry.totalAmount += tx.amount;
    entry.days.push(parseInt(tx.date.slice(8, 10), 10));
    entry.count++;
  }

  const recurring: RecurringBill[] = [];
  for (const [desc, data] of byDesc) {
    if (data.months.size < 2) continue;

    const avgAmount = data.totalAmount / data.count;

    data.days.sort((a, b) => a - b);
    const mid = Math.floor(data.days.length / 2);
    const typicalDay =
      data.days.length % 2 === 0
        ? Math.round((data.days[mid - 1] + data.days[mid]) / 2)
        : data.days[mid];

    recurring.push({
      description: desc,
      avgAmount,
      typicalDay,
      monthCount: data.months.size,
    });
  }

  const today = new Date();
  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() + 1 === month;
  const currentDay = isCurrentMonth ? today.getDate() : 0;
  const daysInMonth = new Date(year, month, 0).getDate();

  const upcoming = recurring.filter((b) => {
    const day = Math.min(b.typicalDay, daysInMonth);
    if (isCurrentMonth) return day >= currentDay;
    return true;
  });

  upcoming.sort((a, b) => a.typicalDay - b.typicalDay);
  return upcoming;
}
