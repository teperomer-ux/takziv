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
