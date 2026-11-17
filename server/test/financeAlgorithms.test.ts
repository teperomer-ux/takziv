import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chargeDate,
  clampBillingDay,
  comparableToDate,
  cycleStatus,
  defaultViewMonth,
  elapsedFraction,
  isFutureCharge,
  splitFutureCharges,
} from "../../src/utils/billingCycle.js";
import { detectRecurring, merchantHint, merchantKey, type RecurringTx } from "../../src/utils/recurringBills.js";
import { buildInsights } from "../../src/utils/insights.js";
import { buildSavingsProfile } from "../../src/utils/savingsProfile.js";

// ── Fixtures ────────────────────────────────────────────────────────

/** A card purchase: billed the month after it was made. */
function card(date: string, description: string, amount: number, extra: Partial<RecurringTx> = {}): RecurringTx {
  const [y, m] = date.split("-").map(Number);
  const [billingYear, billingMonth] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { date, description, amount, category: "", billingYear, billingMonth, source: "max", ...extra };
}

/** A bank debit: charged the day it happens. */
function bank(date: string, description: string, amount: number, extra: Partial<RecurringTx> = {}): RecurringTx {
  const [y, m] = date.split("-").map(Number);
  return { date, description, amount, category: "", billingYear: y, billingMonth: m, source: "bank", ...extra };
}

/** `description` bought on `day` of each of `months` (1-12, year 2026). */
function monthly(description: string, day: number, months: number[], amounts: number | number[], extra: Partial<RecurringTx> = {}) {
  return months.map((m, i) =>
    card(`2026-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, description, Array.isArray(amounts) ? amounts[i] : amounts, extra),
  );
}

const names = (r: { charges: { description: string }[] }) => r.charges.map((c) => c.description);

// ── Billing cycle ───────────────────────────────────────────────────

test("a card charge billed next month is a future charge; a bank debit never is", () => {
  const december = card("2026-11-12", "NETFLIX", 55);
  assert.equal(december.billingMonth, 12);
  assert.equal(isFutureCharge(december, "2026-11-17"), true);
  assert.equal(isFutureCharge(december, "2026-12-01"), false);
  assert.equal(isFutureCharge(bank("2026-11-30", "משכנתא", 4000), "2026-11-17"), false);

  const november = card("2026-10-20", "NETFLIX", 55);
  const { current, future } = splitFutureCharges([december, november], "2026-11-17");
  assert.deepEqual([current.length, future.length], [1, 1]);
});

test("a year boundary is handled: a January charge is future in December", () => {
  assert.equal(isFutureCharge(card("2026-12-05", "SPOTIFY", 20), "2026-12-20"), true);
  assert.equal(isFutureCharge(card("2026-12-05", "SPOTIFY", 20), "2027-01-01"), false);
});

test("the billing day sets when a cycle is debited", () => {
  const cfg = { billingDay: 10, billingDayBySource: { cal: 2 } };
  assert.equal(chargeDate(card("2026-10-20", "X", 1), cfg), "2026-11-10");
  assert.equal(chargeDate(card("2026-10-20", "X", 1, { source: "cal" }), cfg), "2026-11-02");
  assert.equal(chargeDate(bank("2026-10-20", "X", 1), cfg), "2026-10-20");
  assert.equal(cycleStatus(2026, 11, "2026-11-05", 10), "upcoming");
  assert.equal(cycleStatus(2026, 11, "2026-11-10", 10), "charged");
  assert.equal(cycleStatus(2026, 12, "2026-11-17", 10), "future");
  assert.equal(cycleStatus(2026, 10, "2026-11-17", 10), "charged");
});

test("billing day input is clamped to 1–28 and defaults to 10", () => {
  assert.equal(clampBillingDay(31), 28);
  assert.equal(clampBillingDay(0), 1);
  assert.equal(clampBillingDay("15"), 15);
  assert.equal(clampBillingDay(undefined), 10);
});

test("the opening month follows the user's preference", () => {
  assert.deepEqual(defaultViewMonth("2026-11-17", "current"), [2026, 11]);
  assert.deepEqual(defaultViewMonth("2026-11-17", "previous"), [2026, 10]);
  assert.deepEqual(defaultViewMonth("2027-01-03", "previous"), [2026, 12]);
});

test("a running month is compared to the same day of earlier months", () => {
  assert.equal(elapsedFraction(2026, 11, "2026-11-15"), 0.5);
  assert.equal(elapsedFraction(2026, 10, "2026-11-15"), 1);
  assert.equal(elapsedFraction(2026, 12, "2026-11-15"), 0);
  assert.equal(comparableToDate(bank("2026-10-25", "X", 1), 17), false);
  assert.equal(comparableToDate(bank("2026-10-05", "X", 1), 17), true);
  // A card cycle is closed before its month starts.
  assert.equal(comparableToDate(card("2026-09-28", "X", 1), 17), true);
});

// ── Fixed charges ───────────────────────────────────────────────────

test("a monthly subscription on a steady day and amount is a fixed charge", () => {
  const r = detectRecurring(monthly("NETFLIX.COM", 5, [7, 8, 9], 54.9), 2026, 10, { today: "2026-10-20" });
  assert.deepEqual(names(r), ["NETFLIX.COM"]);
  assert.equal(r.charges[0].kind, "subscription");
  assert.equal(r.charges[0].status, "charged");
  assert.equal(r.charges[0].cadence, 1);
  assert.equal(r.monthlyTotal, 54.9);
});

test("repeat visits to the same shop are not a fixed charge", () => {
  const supermarket = [7, 8, 9].flatMap((m) =>
    [3, 10, 17, 24].map((d, i) => card(`2026-0${m}-${String(d).padStart(2, "0")}`, "שופרסל דיל", 250 + i * 40)),
  );
  // Same price every time, several times a month: still a habit, not a bill.
  const coffee = [7, 8, 9].flatMap((m) => [2, 9, 16, 23].map((d) => card(`2026-0${m}-${String(d).padStart(2, "0")}`, "דוכן השכונה", 14)));
  const r = detectRecurring([...supermarket, ...coffee], 2026, 10, { today: "2026-10-20" });
  assert.deepEqual(r.charges, []);
  assert.deepEqual(r.alerts, []);
});

test("a once-a-month visit to a restaurant, fuel station or Wolt is still not fixed", () => {
  const rows = [
    ...monthly("WOLT", 12, [7, 8, 9], 89),
    ...monthly("פז קמעונאות ואנרגיה", 20, [7, 8, 9], 300),
    ...monthly("מסעדת הדייגים", 1, [7, 8, 9], 220),
  ];
  assert.deepEqual(detectRecurring(rows, 2026, 10, { today: "2026-10-20" }).charges, []);
});

test("the merchant's own name decides its type, then its category", () => {
  assert.equal(merchantHint("WOLT PLUS"), "positive");
  assert.equal(merchantHint("WOLT"), "negative");
  assert.equal(merchantHint("רמי לוי תקשורת"), "positive");
  assert.equal(merchantHint("רמי לוי שיווק השקמה"), "negative");
  assert.equal(merchantHint("חברת החשמל לישראל"), "utility");
  assert.equal(merchantHint("הראל חברה לביטוח"), "positive");
  assert.equal(merchantHint("מועדון חבר"), "negative");
  assert.equal(merchantHint("עמי כהן"), "neutral");
  assert.equal(merchantHint("א.ב. שירותים", "פנאי ובידור", "מנויים"), "positive");
  assert.equal(merchantHint("א.ב. שירותים", "מזון וטיפוח", "סופרמרקט"), "negative");
});

test("a dollar subscription whose shekel price drifts with the exchange rate is one fixed charge", () => {
  const drifting = monthly("CLAUDE.AI SUBSCRIPTION", 14, [6, 7, 8, 9], [65, 70, 74.5, 79], {
    originalAmount: 20,
    originalCurrency: "USD",
  });
  const r = detectRecurring(drifting, 2026, 10, { today: "2026-10-20" });
  assert.deepEqual(names(r), ["CLAUDE.AI SUBSCRIPTION"]);
  assert.deepEqual(r.charges[0].original, { amount: 20, currency: "USD" });
  // 79 vs 74.5 is the exchange rate, not a price increase.
  assert.deepEqual(r.alerts, []);

  // No original amount stored: ±12 % still covers 65 → 70.
  const plain = detectRecurring(monthly("OPENAI *CHATGPT", 3, [8, 9], [65, 70]), 2026, 10, { today: "2026-10-20" });
  assert.deepEqual(names(plain), ["OPENAI *CHATGPT"]);
});

test("a merchant whose amounts swing wildly is rejected", () => {
  const r = detectRecurring(monthly("י.ד. שירותים", 10, [7, 8, 9], [40, 350, 120]), 2026, 10, { today: "2026-10-20" });
  assert.deepEqual(r.charges, []);
});

test("an inconsistent day of the month is rejected for an unknown merchant", () => {
  const rows = [card("2026-06-03", "י.ד. שירותים", 100), card("2026-07-08", "י.ד. שירותים", 100), card("2026-08-13", "י.ד. שירותים", 100)];
  assert.deepEqual(detectRecurring(rows, 2026, 9, { today: "2026-09-20" }).charges, []);
});

test("a bi-monthly utility bill is fixed even though its amount varies", () => {
  const rows = [
    bank("2026-05-10", "חברת החשמל לישראל", 410),
    bank("2026-07-14", "חברת החשמל לישראל", 560),
    bank("2026-09-08", "חברת החשמל לישראל", 470),
  ];
  const september = detectRecurring(rows, 2026, 9, { today: "2026-10-20" });
  assert.equal(september.charges[0].kind, "utility");
  assert.equal(september.charges[0].cadence, 2);
  assert.equal(september.charges[0].monthlyCost, 235);
  // The month between two bills: still listed, nothing "stopped".
  const october = detectRecurring(rows, 2026, 10, { today: "2026-10-20" });
  assert.equal(october.charges[0].status, "off-month");
  assert.deepEqual(october.alerts, []);
});

test("a standing order from the bank account is detected", () => {
  const rows = [8, 9, 10].map((m) => bank(`2026-${String(m).padStart(2, "0")}-01`, "משכנתא בנק לאומי", 4200));
  const r = detectRecurring(rows, 2026, 10, { today: "2026-10-20" });
  assert.equal(r.charges[0].kind, "standing-order");
});

test("a price increase on an established charge raises one alert", () => {
  const r = detectRecurring(monthly("הולמס פלייס", 2, [6, 7, 8, 9], [220, 220, 220, 259]), 2026, 10, { today: "2026-10-20" });
  assert.deepEqual(names(r), ["הולמס פלייס"]);
  assert.deepEqual(r.alerts, [
    { kind: "amount-changed", key: merchantKey("הולמס פלייס"), description: "הולמס פלייס", previousAmount: 220, currentAmount: 259, diff: 39 },
  ]);
});

test("a charge that did not arrive is expected while still due, then stopped", () => {
  const order = [7, 8, 9].map((m) => bank(`2026-0${m}-20`, "ועד בית", 250));
  const due = detectRecurring(order, 2026, 10, { today: "2026-10-03" });
  assert.equal(due.charges[0].status, "expected");
  assert.deepEqual(due.alerts, []);
  // Due around 20/10; a week and more later it clearly did not come.
  const late = detectRecurring(order, 2026, 10, { today: "2026-10-30" });
  assert.deepEqual(late.charges, []);
  assert.deepEqual(late.alerts.map((a) => a.kind), ["stopped"]);
  // A past month is judged as a whole.
  assert.deepEqual(detectRecurring(order, 2026, 10, { today: "2026-12-05" }).alerts.map((a) => a.kind), ["stopped"]);

  // A card cycle is closed before its month starts: a subscription bought on
  // the 20th that is missing from October's bill was already skipped in September.
  const cardSub = monthly("SPOTIFY", 20, [6, 7, 8], 23.9); // billed July–September
  assert.deepEqual(detectRecurring(cardSub, 2026, 10, { today: "2026-10-03" }).alerts.map((a) => a.kind), ["stopped"]);
});

test("a fixed charge is announced as new only when there is history before it", () => {
  const netflix = monthly("NETFLIX.COM", 5, [8, 9], 54.9);
  // The data itself starts with it: nothing to compare with.
  assert.deepEqual(detectRecurring(netflix, 2026, 10, { today: "2026-10-20" }).alerts, []);
  const withHistory = [card("2026-05-02", "IKEA", 900), ...netflix];
  assert.deepEqual(
    detectRecurring(withHistory, 2026, 10, { today: "2026-10-20" }).alerts.map((a) => a.kind),
    ["new"],
  );
});

test("a subscription hidden among other purchases at the same merchant is found on its own", () => {
  const icloud = monthly("APPLE.COM/BILL", 9, [6, 7, 8, 9], 11.9);
  const apps = [
    card("2026-07-15", "APPLE.COM/BILL", 39.9),
    card("2026-08-02", "APPLE.COM/BILL", 7.9),
    card("2026-09-21", "APPLE.COM/BILL", 119),
  ];
  const r = detectRecurring([...icloud, ...apps], 2026, 10, { today: "2026-10-20" });
  assert.equal(r.charges.length, 1);
  assert.equal(r.charges[0].amount, 11.9);
});

test("the user's marking wins in both directions", () => {
  const key = merchantKey("NETFLIX.COM");
  const netflix = monthly("NETFLIX.COM", 5, [7, 8, 9], 54.9);
  assert.deepEqual(detectRecurring(netflix, 2026, 10, { notFixed: new Set([key]), today: "2026-10-20" }).charges, []);

  const allowance = [
    card("2026-08-03", "העברה לילדים", 200),
    card("2026-08-18", "העברה לילדים", 150),
    card("2026-09-04", "העברה לילדים", 200),
    card("2026-09-19", "העברה לילדים", 180),
  ];
  assert.deepEqual(detectRecurring(allowance, 2026, 10, { today: "2026-10-20" }).charges, []);
  const marked = detectRecurring(allowance, 2026, 10, { fixed: new Set([merchantKey("העברה לילדים")]), today: "2026-10-20" });
  assert.equal(marked.charges[0].kind, "manual");
  assert.equal(marked.charges[0].amount, 380);
  assert.equal(marked.charges[0].userMarked, true);
});

test("an installment plan is a fixed commitment until its last payment", () => {
  const plan = (billingMonth: number, n: number): RecurringTx => ({
    date: "2026-06-15",
    description: "אלקטרה מוצרי צריכה",
    amount: 300,
    category: "",
    billingYear: 2026,
    billingMonth,
    source: "isracard",
    installmentNumber: n,
    installmentTotal: 4,
  });
  const rows = [plan(7, 1), plan(8, 2), plan(9, 3)];
  const r = detectRecurring(rows, 2026, 9, { today: "2026-09-20" });
  assert.equal(r.charges[0].kind, "installment");
  assert.deepEqual(r.charges[0].installment, { number: 3, total: 4 });
  // Next month's payment hasn't been published yet: expected, as payment 4.
  const next = detectRecurring(rows, 2026, 10, { today: "2026-10-03" });
  assert.deepEqual([next.charges[0].status, next.charges[0].installment?.number], ["expected", 4]);
  // After the last payment nothing is left.
  const done = detectRecurring([...rows, plan(10, 4)], 2026, 11, { today: "2026-11-03" });
  assert.deepEqual(done.charges, []);
});

test("income rows, refunds and internal transfers are never fixed charges", () => {
  const rows = [
    ...monthly("משכורת", 9, [7, 8, 9], 12000, { category: "מקורות הכנסה" }),
    ...monthly("NETFLIX.COM", 5, [7, 8, 9], -54.9),
    ...monthly("העברה לחיסכון", 1, [7, 8, 9], 1000, { category: "העברות פנימיות" }),
  ];
  const r = detectRecurring(rows, 2026, 10, { excludedCategories: new Set(["העברות פנימיות"]), today: "2026-10-20" });
  assert.deepEqual(r.charges, []);
});

// ── Insights ────────────────────────────────────────────────────────

const noRecurring = { charges: [], alerts: [] };
const insightsFor = (history: RecurringTx[], year: number, month: number, today: string, recurring = noRecurring) =>
  buildInsights({ history, year, month, today, excludedCategories: new Set(["העברות פנימיות"]), recurring });

test("a running month is compared with the same point of last month, not the whole of it", () => {
  const groceries = (date: string, amount: number) => bank(date, "מכולת", amount, { category: "מזון" });
  const history = [
    // October: 1,000 by the 10th, 3,000 by the end.
    groceries("2026-10-05", 1000),
    groceries("2026-10-20", 2000),
    // November so far: 1,050 by the 10th — on pace, although far below October's 3,000.
    groceries("2026-11-04", 1050),
  ];
  assert.deepEqual(insightsFor(history, 2026, 11, "2026-11-10"), []);

  const fast = [...history, groceries("2026-11-08", 700)];
  const [pace] = insightsFor(fast, 2026, 11, "2026-11-10");
  assert.equal(pace.id, "pace");
  assert.equal(pace.type, "warning");
  assert.match(pace.text, /75%/); // 1,750 vs 1,000
});

test("a category spike names the merchant behind it; small moves stay silent", () => {
  const history = [
    ...[7, 8, 9].map((m) => bank(`2026-0${m}-10`, "טיפול שיניים", 400, { category: "בריאות" })),
    ...[7, 8, 9].map((m) => bank(`2026-0${m}-12`, "ביגוד", 500, { category: "ביגוד והנעלה" })),
    bank("2026-10-10", "מרפאת שיניים ד\"ר לוי", 1900, { category: "בריאות" }),
    bank("2026-10-12", "ביגוד", 540, { category: "ביגוד והנעלה" }),
  ];
  const insights = insightsFor(history, 2026, 10, "2026-11-17");
  const spike = insights.find((i) => i.id === "spike-בריאות");
  assert.ok(spike);
  assert.match(spike.text, /מרפאת שיניים/);
  assert.equal(insights.some((i) => i.id.includes("ביגוד")), false);
});

test("a month that has not started, or has no data, produces no insights", () => {
  const history = [bank("2026-10-10", "מכולת", 500, { category: "מזון" })];
  assert.deepEqual(insightsFor(history, 2026, 12, "2026-11-17"), []);
  assert.deepEqual(insightsFor(history, 2026, 9, "2026-11-17"), []);
});

test("price increases and new fixed charges are reported once, with their yearly cost", () => {
  const history = [bank("2026-10-10", "הולמס פלייס", 259, { category: "ספורט" })];
  const recurring = {
    charges: [{ key: "netflix", monthlyCost: 55 }],
    alerts: [
      { kind: "amount-changed" as const, key: "gym", description: "הולמס פלייס", previousAmount: 220, currentAmount: 259, diff: 39 },
      { kind: "new" as const, key: "netflix", description: "NETFLIX" },
    ],
  };
  const insights = buildInsights({
    history,
    year: 2026,
    month: 10,
    today: "2026-11-17",
    excludedCategories: new Set(),
    recurring: recurring as never,
  });
  assert.deepEqual(insights.map((i) => i.id), ["price-gym", "new-fixed"]);
  assert.match(insights[0].text, /468/); // 39 × 12
});

test("uncategorised rows are flagged with an action; internal transfers are ignored", () => {
  const history = [
    bank("2026-10-02", "א", 100),
    bank("2026-10-03", "ב", 100),
    bank("2026-10-04", "ג", 100),
    bank("2026-10-05", "העברה לפיקדון", 50000, { category: "העברות פנימיות" }),
  ];
  const insights = insightsFor(history, 2026, 10, "2026-11-17");
  assert.deepEqual(insights.map((i) => [i.id, i.action]), [["uncategorized", "categorize"]]);
  assert.match(insights[0].text, /300/);
});

// ── Savings profile ─────────────────────────────────────────────────

const salary = (month: number, amount: number) => ({ date: `2026-${String(month).padStart(2, "0")}-09`, amount, category: "משכורת" });
const spend = (month: number, amount: number, description = "הוצאות", category = "מזון") =>
  bank(`2026-${String(month).padStart(2, "0")}-15`, description, amount, { category });

function profileOf(overrides: Partial<Parameters<typeof buildSavingsProfile>[0]>) {
  return buildSavingsProfile({
    expenses: [],
    incomes: [],
    excludedExpenseCategories: new Set(["העברות פנימיות"]),
    excludedIncomeCategories: new Set(["העברות פנימיות"]),
    fixed: { monthlyTotal: 0, charges: [] },
    today: "2026-11-17",
    ...overrides,
  });
}

test("the savings rate comes from complete months with both income and spending", () => {
  const p = profileOf({
    incomes: [salary(8, 10000), salary(9, 10000), salary(10, 10000), salary(11, 10000)],
    expenses: [spend(8, 8000), spend(9, 9000), spend(10, 7000), spend(11, 500)],
    fixed: { monthlyTotal: 4000, charges: [{ key: "rent", description: "שכר דירה", monthlyCost: 4000 }] },
  });
  assert.equal(p.status, "ok");
  // November is still running: left out.
  assert.equal(p.monthsUsed, 3);
  assert.equal(p.avgIncome, 10000);
  assert.equal(p.avgExpenses, 8000);
  assert.equal(p.netSavings, 2000);
  assert.equal(p.savingsRate, 0.2);
  assert.equal(p.fixedRatio, 0.5);
  assert.equal(p.variableMonthly, 4000);
  assert.equal(p.gap, 0);
  assert.equal(p.projection12, 24000);
  assert.equal(p.level, "excellent");
});

test("a month without income is left out instead of counting as a deficit", () => {
  const p = profileOf({
    incomes: [salary(9, 10000), salary(10, 10000)],
    expenses: [spend(8, 9000), spend(9, 9000), spend(10, 9000)],
  });
  assert.equal(p.monthsUsed, 2);
  assert.equal(p.monthsMissingIncome, 1);
  assert.equal(p.savingsRate, 0.1);
  assert.ok(p.tips.some((t) => t.includes("אין נתוני הכנסה")));
});

test("a deficit is reported as a negative rate with a realistic first cut", () => {
  const p = profileOf({
    incomes: [salary(9, 8000), salary(10, 8000)],
    expenses: [spend(9, 10000), spend(10, 10000)],
    fixed: { monthlyTotal: 4000, charges: [] },
  });
  assert.equal(p.netSavings, -2000);
  assert.equal(p.savingsRate, -0.25);
  assert.equal(p.projection12, 0);
  // 15 % of the 6,000 variable spending, not the whole 3,600 gap.
  assert.equal(p.suggestedCut, 900);
  assert.equal(p.level, "at-risk");
  assert.match(p.tips[0], /איזון/);
});

test("a rate never drops below -100 %, and fixed costs never exceed spending", () => {
  const p = profileOf({
    incomes: [salary(10, 1000)],
    expenses: [spend(10, 9000)],
    fixed: { monthlyTotal: 20000, charges: [] },
  });
  assert.equal(p.savingsRate, -1);
  assert.equal(p.fixedRatio, 1);
  assert.equal(p.variableMonthly, 0);
});

test("internal transfers, future charges' absence and missing data are handled", () => {
  const p = profileOf({
    incomes: [salary(10, 10000), { date: "2026-10-12", amount: 50000, category: "העברות פנימיות" }],
    expenses: [spend(10, 6000), spend(10, 30000, "קניית ני\"ע", "העברות פנימיות")],
  });
  assert.equal(p.avgIncome, 10000);
  assert.equal(p.avgExpenses, 6000);

  assert.equal(profileOf({}).status, "insufficient");
  assert.equal(profileOf({ expenses: [spend(10, 500)] }).status, "insufficient");
});

test("manual expenses count as spending, and manual recurring ones as fixed", () => {
  const p = profileOf({
    incomes: [salary(10, 10000)],
    expenses: [spend(10, 5000)],
    manualExpensesFor: () => 1000,
    manualFixedMonthly: 1000,
  });
  assert.equal(p.avgExpenses, 6000);
  assert.equal(p.fixedMonthly, 1000);
});

test("uncategorised income is called out when it could be inflating the rate", () => {
  const p = profileOf({
    incomes: [salary(10, 10000), { date: "2026-10-20", amount: 5000, category: "" }],
    expenses: [spend(10, 9000)],
  });
  assert.ok(p.tips.some((t) => t.includes("ללא סיווג")));
});
