import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyTypes } from "israeli-bank-scrapers";
import { mapScrapedTransactions } from "../src/transactionMapper.js";
import type { ScrapedAccount } from "../src/scrapeRunner.js";

const noMappings = { expense: [], income: [] };

function account(txns: Partial<ScrapedAccount["txns"][number]>[]): ScrapedAccount {
  return {
    accountNumber: "1234",
    txns: txns.map((t) => ({
      type: "normal",
      date: "2026-09-03T21:00:00.000Z",
      processedDate: "2026-10-01T21:00:00.000Z",
      originalAmount: -120,
      originalCurrency: "ILS",
      chargedAmount: -120,
      description: "שופרסל דיל",
      status: "completed",
      ...t,
    })),
  } as ScrapedAccount;
}

test("re-mapping the same scrape yields the same doc ids (dedupe key)", () => {
  const scrape = [account([{}, { description: "פז", chargedAmount: -250 }])];
  const a = mapScrapedTransactions(CompanyTypes.max, scrape, noMappings).expenses.map((t) => t.id);
  const b = mapScrapedTransactions(CompanyTypes.max, scrape, noMappings).expenses.map((t) => t.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 2);
});

test("identical same-day rows get distinct ids", () => {
  const ids = mapScrapedTransactions(CompanyTypes.max, [account([{}, {}])], noMappings).expenses.map((t) => t.id);
  assert.equal(new Set(ids).size, 2);
});

test("dates are the Israeli calendar day and charges become positive", () => {
  const [tx] = mapScrapedTransactions(CompanyTypes.isracard, [account([{}])], noMappings).expenses;
  assert.equal(tx.date, "2026-09-04");
  assert.equal(tx.amount, 120);
  assert.equal(tx.source, "isracard");
  assert.deepEqual([tx.billingMonth, tx.billingYear], [10, 2026]);
});

test("pending rows are skipped", () => {
  const r = mapScrapedTransactions(CompanyTypes.max, [account([{ status: "pending" as ScrapedAccount["txns"][number]["status"] }])], noMappings);
  assert.equal(r.expenses.length, 0);
  assert.equal(r.skippedPending, 1);
});

test("each supported provider tags expenses with the app's source slug", () => {
  const expected: [CompanyTypes, string][] = [
    [CompanyTypes.max, "max"],
    [CompanyTypes.isracard, "isracard"],
    [CompanyTypes.visaCal, "cal"],
    [CompanyTypes.hapoalim, "bank"],
    [CompanyTypes.leumi, "bank"],
    [CompanyTypes.discount, "bank"],
  ];
  for (const [company, source] of expected) {
    const [tx] = mapScrapedTransactions(company, [account([{ description: "קפה" }])], noMappings).expenses;
    assert.equal(tx.source, source, company);
  }
});

test("bank debits are expenses and credits are incomes, never the other way round", () => {
  const bank = account([
    { description: "הע. לשרה אבבה בסניף 12-668", chargedAmount: -4300, originalAmount: -4300 },
    { description: "משכורת", chargedAmount: 12000, originalAmount: 12000 },
  ]);
  const { expenses, incomes } = mapScrapedTransactions(CompanyTypes.discount, [bank], noMappings);
  assert.deepEqual(expenses.map((t) => [t.description, t.amount]), [["הע. לשרה אבבה בסניף 12-668", 4300]]);
  assert.deepEqual(incomes.map((t) => [t.description, t.amount]), [["משכורת", 12000]]);
});

test("the direction falls back to originalAmount when chargedAmount is missing; zero rows are skipped", () => {
  const bank = account([
    { chargedAmount: undefined as unknown as number, originalAmount: -4300 },
    { chargedAmount: 0, originalAmount: 0 },
  ]);
  const result = mapScrapedTransactions(CompanyTypes.discount, [bank], noMappings);
  assert.deepEqual(result.expenses.map((t) => t.amount), [4300]);
  assert.equal(result.incomes.length, 0);
  assert.equal(result.skippedZeroAmount, 1);
});

test("syncing the same bank statement twice maps to the same ids", () => {
  const statement = () => [account([{ description: "הע. לשרה אבבה בסניף 12-668", chargedAmount: -4300 }, {}])];
  const first = mapScrapedTransactions(CompanyTypes.discount, statement(), noMappings).expenses.map((t) => t.id);
  const second = mapScrapedTransactions(CompanyTypes.discount, statement(), noMappings).expenses.map((t) => t.id);
  assert.deepEqual(first, second);
});
