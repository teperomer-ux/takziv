/**
 * Billing-cycle rules, shared by every month view (dashboard, expenses,
 * insights, fixed charges).
 *
 * A credit-card purchase belongs to the month it is CHARGED in (billingYear /
 * billingMonth, taken from the card company's charge date), not the month it
 * was bought in. Card companies publish next month's charges long before they
 * are debited, so a row can belong to a cycle that hasn't arrived yet. Those
 * rows are "future charges": they stay out of every total, average and
 * insight until the calendar reaches their billing month.
 *
 * Bank (עו״ש) rows are debited on their own date and are never future.
 *
 * Pure — no browser or Firebase imports — so the sync server's tests run it.
 */

export const DEFAULT_BILLING_DAY = 10;
export const MIN_BILLING_DAY = 1;
export const MAX_BILLING_DAY = 28;

/** The days Israeli card companies actually offer, shown first in the picker. */
export const COMMON_BILLING_DAYS = [2, 10, 15, 20];

export type DefaultMonthView = "current" | "previous";

export interface BillingConfig {
  /** Day of the month the cards are debited from the bank account. */
  billingDay: number;
  /** Optional override per card company (max / isracard / cal). */
  billingDayBySource?: Partial<Record<string, number>>;
}

/** The minimal row shape the cycle rules need. */
export interface CycleRow {
  /** YYYY-MM-DD — purchase date (card) or debit date (bank). */
  date: string;
  billingYear: number;
  billingMonth: number;
  source?: string;
}

export function clampBillingDay(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_BILLING_DAY;
  return Math.min(MAX_BILLING_DAY, Math.max(MIN_BILLING_DAY, Math.round(n)));
}

export function billingDayFor(source: string | undefined, cfg: BillingConfig): number {
  const override = source ? cfg.billingDayBySource?.[source] : undefined;
  return clampBillingDay(override ?? cfg.billingDay);
}

/** Months since year 0 — makes month arithmetic and comparison trivial. */
export function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

export function fromMonthIndex(index: number): [year: number, month: number] {
  return [Math.floor(index / 12), (index % 12) + 1];
}

export function ymKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** [year, month, day] of a YYYY-MM-DD string. */
export function parseYmd(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split("-").map(Number);
  return [y, m, d];
}

/** Bank rows are debited directly; everything else (incl. untagged legacy rows) is a card row. */
export function isCardRow(row: Pick<CycleRow, "source">): boolean {
  return row.source !== "bank";
}

/** The month a row counts toward, as a month index. */
export function cycleIndex(row: Pick<CycleRow, "billingYear" | "billingMonth">): number {
  return monthIndex(row.billingYear, row.billingMonth);
}

/**
 * The day the money leaves the bank account: the debit date for a bank row,
 * the billing day of the billing month for a card row.
 */
export function chargeDate(row: CycleRow, cfg: BillingConfig): string {
  if (!isCardRow(row)) return row.date;
  const day = Math.min(billingDayFor(row.source, cfg), daysInMonth(row.billingYear, row.billingMonth));
  return `${ymKey(row.billingYear, row.billingMonth)}-${String(day).padStart(2, "0")}`;
}

/**
 * True for a card row whose billing cycle is a month that hasn't started yet
 * (e.g. a December charge while it is still November).
 */
export function isFutureCharge(row: CycleRow, todayYmd: string): boolean {
  if (!isCardRow(row)) return false;
  const [y, m] = parseYmd(todayYmd);
  return cycleIndex(row) > monthIndex(y, m);
}

export function splitFutureCharges<T extends CycleRow>(rows: readonly T[], todayYmd: string): { current: T[]; future: T[] } {
  const current: T[] = [];
  const future: T[] = [];
  for (const row of rows) (isFutureCharge(row, todayYmd) ? future : current).push(row);
  return { current, future };
}

export type CycleStatus =
  /** The month hasn't started — its card charges are future charges. */
  | "future"
  /** The current month, before the billing day: charges are known but not debited yet. */
  | "upcoming"
  /** The cards were already debited for this month. */
  | "charged";

export function cycleStatus(year: number, month: number, todayYmd: string, billingDay: number): CycleStatus {
  const [ty, tm, td] = parseYmd(todayYmd);
  const diff = monthIndex(year, month) - monthIndex(ty, tm);
  if (diff > 0) return "future";
  if (diff < 0) return "charged";
  return td < Math.min(clampBillingDay(billingDay), daysInMonth(year, month)) ? "upcoming" : "charged";
}

/** The month the app opens on: this calendar month, or the last one that fully ended. */
export function defaultViewMonth(todayYmd: string, view: DefaultMonthView): [year: number, month: number] {
  const [y, m] = parseYmd(todayYmd);
  return view === "previous" ? fromMonthIndex(monthIndex(y, m) - 1) : [y, m];
}

/**
 * How much of a month has elapsed: 1 for a past month, day/daysInMonth for the
 * current one, 0 for a future one.
 */
export function elapsedFraction(year: number, month: number, todayYmd: string): number {
  const [ty, tm, td] = parseYmd(todayYmd);
  const diff = monthIndex(year, month) - monthIndex(ty, tm);
  if (diff < 0) return 1;
  if (diff > 0) return 0;
  return td / daysInMonth(year, month);
}

/**
 * Whether a row of an earlier month is comparable with a month that has only
 * reached `dayLimit`. A card cycle is closed before its month starts, so card
 * rows always count; bank rows count only up to the same day of the month.
 */
export function comparableToDate(row: CycleRow, dayLimit: number): boolean {
  if (isCardRow(row)) return true;
  return parseYmd(row.date)[2] <= dayLimit;
}
