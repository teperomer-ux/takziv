import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  availableMonths,
  categoryTotals,
  filterRows,
  largestRows,
  monthSummary,
  totals,
  type FinanceRow,
} from "../src/financeQueries.js";
import { toFinanceRow, type UserFinanceData } from "../src/financeData.js";
import { ASSISTANT_TOOLS, executeTool } from "../src/assistantTools.js";
import { buildSystemPrompt, configuredProvider } from "../src/assistantModel.js";
import { allowQuestion } from "../src/aiRoute.js";

function row(overrides: Partial<FinanceRow> = {}): FinanceRow {
  return {
    kind: "expense",
    date: "2026-04-10",
    month: "2026-04",
    description: "שופרסל דיל",
    amount: 100,
    category: "מזון",
    subCategory: "סופרמרקט",
    account: "card",
    excluded: false,
    ...overrides,
  };
}

const rows: FinanceRow[] = [
  row(),
  row({ description: "רמי לוי", amount: 250.55, date: "2026-04-20" }),
  row({ description: "הע. לשרה אבבה", amount: 4300, category: "דיור", subCategory: "שכירות", account: "bank" }),
  row({ description: "העברה בין חשבונות", amount: 9000, category: "העברות פנימיות", account: "bank", excluded: true }),
  row({ description: "קפה", amount: 18, category: "", subCategory: "" }),
  row({ description: "שופרסל", amount: 80, month: "2026-05", date: "2026-05-02" }),
  row({ kind: "income", description: "משכורת", amount: 12000, category: "משכורת", account: "bank" }),
  row({ kind: "income", description: "פדיון פיקדון", amount: 5000, category: "העברות פנימיות", account: "bank", excluded: true }),
];
const data: UserFinanceData = { rows, categories: { expense: { מזון: ["סופרמרקט"], דיור: [] }, income: { משכורת: [] } } };

test("totals keep internal transfers apart and count uncategorised rows", () => {
  assert.deepEqual(totals(filterRows(rows, { kind: "expense", month: "2026-04" })), {
    count: 5,
    counted: 4668.55,
    excluded: 9000,
    uncategorized: 18,
  });
});

test("filters match the month, account, description text and amount range", () => {
  assert.equal(filterRows(rows, { month: "2026-05" }).length, 1);
  assert.equal(filterRows(rows, { kind: "expense", account: "bank", includeExcluded: false }).length, 1);
  assert.equal(filterRows(rows, { text: "שופרסל" }).length, 2);
  assert.equal(filterRows(rows, { kind: "expense", minAmount: 200, maxAmount: 5000 }).length, 2);
  assert.equal(filterRows(rows, { fromMonth: "2026-05", toMonth: "2026-06" }).length, 1);
});

test("a category matches by exact name first, then by part of the name", () => {
  const withSimilar = [...rows, row({ category: "מזון בחוץ", description: "פיצה", amount: 60 })];
  assert.equal(filterRows(withSimilar, { category: "מזון", month: "2026-04" }).length, 2);
  assert.equal(filterRows(withSimilar, { category: "בחוץ" }).length, 1);
  assert.equal(filterRows(withSimilar, { category: "ביגוד" }).length, 0);
});

test("category totals are grouped by category and sub-category, largest first", () => {
  const april = filterRows(rows, { kind: "expense", month: "2026-04", includeExcluded: false });
  const result = categoryTotals(april);
  assert.deepEqual(result.map((c) => [c.category, c.total, c.count]), [["דיור", 4300, 1], ["מזון", 350.55, 2], ["", 18, 1]]);
  assert.deepEqual(result[1].subCategories, [{ subCategory: "סופרמרקט", total: 350.55, count: 2 }]);
});

test("largest rows come by amount, newest first on ties", () => {
  const top = largestRows(filterRows(rows, { kind: "expense", includeExcluded: false }), 2);
  assert.deepEqual(top.map((r) => r.amount), [4300, 250.55]);
  const ties = largestRows([row({ date: "2026-04-01" }), row({ date: "2026-04-09" })], 1);
  assert.equal(ties[0].date, "2026-04-09");
});

test("the month summary splits bank and card spending and reports the balance", () => {
  const s = monthSummary(rows, "2026-04");
  assert.equal(s.expenses.counted, 4668.55);
  assert.equal(s.expenses.bank, 4300);
  assert.equal(s.expenses.card, 368.55);
  assert.equal(s.expenses.excluded, 9000);
  assert.equal(s.incomes.counted, 12000);
  assert.equal(s.incomes.excluded, 5000);
  assert.equal(s.balance, 7331.45);
  assert.equal(s.topExpenseCategories[0].category, "דיור");
  assert.deepEqual(availableMonths(rows), [
    { month: "2026-05", expenses: 1, incomes: 0 },
    { month: "2026-04", expenses: 5, incomes: 2 },
  ]);
});

test("stored docs map to the month the app shows them under", () => {
  const excluded = new Set(["העברות פנימיות"]);
  const date = Timestamp.fromDate(new Date("2026-03-28T00:00:00Z"));
  const card = toFinanceRow(
    "expense",
    { date, amount: 50, description: "x", category: "מזון", billingMonth: 4, billingYear: 2026, source: "max" },
    excluded,
  );
  assert.equal(card.month, "2026-04");
  assert.equal(card.account, "card");
  assert.equal(card.provider, "max");
  const bank = toFinanceRow("expense", { date, amount: 50, description: "x", category: "העברות פנימיות", source: "bank" }, excluded);
  assert.deepEqual([bank.month, bank.account, bank.excluded], ["2026-03", "bank", true]);
  const income = toFinanceRow("income", { date, amount: 10, description: "y", billingMonth: 4, billingYear: 2026 }, excluded);
  assert.equal(income.month, "2026-03");
});

test("the largest-expense tool answers: what was the biggest expense in April", () => {
  const { result, cards } = executeTool("get_largest_transactions", { kind: "expense", month: "2026-04", limit: 1 }, data);
  assert.equal((result as { transactions: { amount: number }[] }).transactions[0].amount, 4300);
  assert.equal(cards[0].type, "transaction");
});

test("the search tool totals a category in a month and finds internal transfers", () => {
  const food = executeTool("search_transactions", { kind: "expense", month: "2026-04", category: "מזון" }, data);
  assert.equal((food.result as { totals: { counted: number } }).totals.counted, 350.55);
  assert.deepEqual(food.cards[0], {
    type: "total",
    kind: "expense",
    label: "הוצאות — אפריל 2026",
    amount: 350.55,
    detail: "2 תנועות · מזון",
  });

  const transfers = executeTool("search_transactions", { month: "2026-04", category: "העברות פנימיות" }, data);
  assert.equal((transfers.result as { totals: { excluded: number } }).totals.excluded, 14000);
});

test("a month without data says so instead of returning zeros", () => {
  assert.deepEqual(executeTool("get_month_summary", { month: "2025-01" }, data), {
    result: { month: "2025-01", noData: true },
    cards: [],
  });
});

test("bad tool names and arguments come back as errors, not exceptions", () => {
  assert.match(JSON.stringify(executeTool("web_search", {}, data).result), /Unknown tool/);
  assert.match(JSON.stringify(executeTool("get_month_summary", { month: "April" }, data).result), /Invalid arguments/);
  assert.match(JSON.stringify(executeTool("get_largest_transactions", { kind: "expense", limit: 500 }, data).result), /Invalid/);
});

test("the tool list offers data tools only, each with an object schema", () => {
  assert.deepEqual(ASSISTANT_TOOLS.map((t) => t.name).sort(), [
    "get_category_totals",
    "get_largest_transactions",
    "get_month_summary",
    "list_available_months",
    "list_categories",
    "search_transactions",
  ]);
  for (const t of ASSISTANT_TOOLS) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal("$schema" in t.inputSchema, false);
  }
});

test("the provider follows the configured key, and the prompt carries today's Israeli date", () => {
  assert.equal(configuredProvider({}), null);
  assert.equal(configuredProvider({ GEMINI_API_KEY: "g" }), "gemini");
  assert.equal(configuredProvider({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }), "anthropic");
  assert.equal(configuredProvider({ AI_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" }), null);
  const prompt = buildSystemPrompt(new Date("2026-10-31T22:30:00Z"));
  assert.match(prompt, /Today is 2026-11-01/);
  assert.match(prompt, /Hebrew/);
});

test("each user gets a limited number of questions per window", () => {
  const store = new Map<string, number[]>();
  assert.ok(allowQuestion("u", 0, 2, store));
  assert.ok(allowQuestion("u", 1, 2, store));
  assert.ok(!allowQuestion("u", 2, 2, store));
  assert.ok(allowQuestion("other", 2, 2, store));
  assert.ok(allowQuestion("u", 11 * 60 * 1000, 2, store));
});

test("card purchases can be looked up by the month they were bought, not billed", () => {
  const billedLater = [row({ date: "2026-04-28", month: "2026-05", amount: 700, description: "מחשב" })];
  const set: UserFinanceData = { ...data, rows: billedLater };
  const byBilling = executeTool("get_largest_transactions", { kind: "expense", month: "2026-04" }, set);
  assert.deepEqual((byBilling.result as { transactions: unknown[] }).transactions, []);
  const byPurchase = executeTool("get_largest_transactions", { kind: "expense", month: "2026-04", date_basis: "purchase" }, set);
  assert.equal((byPurchase.result as { transactions: { amount: number }[] }).transactions[0].amount, 700);
  assert.equal(executeTool("get_month_summary", { month: "2026-04", date_basis: "purchase" }, set).cards[0].type, "total");
});
