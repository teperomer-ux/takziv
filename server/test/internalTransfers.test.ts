import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyTypes } from "israeli-bank-scrapers";
import {
  INTERNAL_TRANSFERS,
  LEGACY_GENERIC_TRANSFER,
  isExcludedFromTotals,
  readExcludeFlag,
  reclassification,
  splitTotals,
  withDefaultExclusion,
} from "../../src/utils/internalTransfers.js";
import { suggestIncomeCategory } from "../../src/utils/incomeClassifier.js";
import { suggestCategory } from "../../src/utils/classifier.js";
import { mapScrapedTransactions } from "../src/transactionMapper.js";
import type { ScrapedAccount } from "../src/scrapeRunner.js";

const excluded = new Set([INTERNAL_TRANSFERS]);

test("splitTotals leaves excluded categories out of the counted total", () => {
  const rows = [
    { amount: 12000, category: "משכורת" },
    { amount: 5000, category: INTERNAL_TRANSFERS },
    { amount: 300, category: "" },
  ];
  assert.deepEqual(splitTotals(rows, excluded), { counted: 12300, excluded: 5000, uncategorized: 300 });
  assert.deepEqual(splitTotals([], excluded), { counted: 0, excluded: 0, uncategorized: 0 });
});

test("only a non-empty category in the excluded set is excluded", () => {
  assert.ok(isExcludedFromTotals(INTERNAL_TRANSFERS, excluded));
  assert.ok(!isExcludedFromTotals("משכורת", excluded));
  assert.ok(!isExcludedFromTotals("", new Set([""])));
});

test("the flag on a category doc wins; without it only the built-in category is excluded", () => {
  assert.equal(readExcludeFlag("חסכונות", true), true);
  assert.equal(readExcludeFlag(INTERNAL_TRANSFERS, false), false);
  assert.equal(readExcludeFlag(INTERNAL_TRANSFERS, undefined), true);
  assert.equal(readExcludeFlag("משכורת", undefined), false);
});

test("internal transfers stay excluded until their category doc exists", () => {
  assert.ok(withDefaultExclusion({}, []).has(INTERNAL_TRANSFERS));
  assert.ok(!withDefaultExclusion({ [INTERNAL_TRANSFERS]: [] }, []).has(INTERNAL_TRANSFERS));
  assert.ok(withDefaultExclusion({ [INTERNAL_TRANSFERS]: [] }, ["חסכונות"]).has("חסכונות"));
});

test("incoming transfers between own accounts and asset sales are not income", () => {
  for (const description of [
    "העברה בין חשבונות 123",
    "העברה עצמית",
    'מכירת ני"ע תיק 55',
    "פדיון פיקדון",
    "פירעון פקדון קצר",
  ]) {
    assert.equal(suggestIncomeCategory(description)?.category, INTERNAL_TRANSFERS, description);
  }
  assert.equal(suggestIncomeCategory("משכורת 10/26")?.category, "משכורת");
});

test("a bare incoming transfer is no longer assumed to be work income", () => {
  assert.deepEqual(suggestIncomeCategory("העברה מיוסי"), {
    category: "שונות",
    subCategory: "העברה בנקאית",
    source: "system",
  });
});

test("outgoing securities purchases and deposits are not spending", () => {
  for (const description of ['קניית ני"ע', "הפקדה לפיקדון", "העברה בין חשבונות"]) {
    assert.equal(suggestCategory(description)?.category, INTERNAL_TRANSFERS, description);
  }
});

test("a learned rule still beats the internal-transfer keyword", () => {
  const mappings = [{ description: "העברה בין חשבונות", category: "משכורת", subCategory: "בונוס" }];
  assert.equal(suggestIncomeCategory("העברה בין חשבונות", mappings)?.category, "משכורת");
});

test("the sync tags an incoming bank transfer as an internal transfer", () => {
  const account = {
    accountNumber: "1",
    txns: [
      {
        type: "normal",
        date: "2026-09-03T21:00:00.000Z",
        processedDate: "2026-09-03T21:00:00.000Z",
        originalAmount: 5000,
        originalCurrency: "ILS",
        chargedAmount: 5000,
        description: "העברה בין חשבונות",
        status: "completed",
      },
    ],
  } as ScrapedAccount;
  const { incomes } = mapScrapedTransactions(CompanyTypes.hapoalim, [account], { expense: [], income: [] });
  assert.equal(incomes[0].category, INTERNAL_TRANSFERS);
});

test("reclassification fills uncategorised rows", () => {
  const next = reclassification({ category: "", subCategory: "" }, suggestIncomeCategory("משכורת"));
  assert.equal(next?.category, "משכורת");
  assert.equal(reclassification({ category: "", subCategory: "" }, undefined), null);
});

test("reclassification moves auto-categorised transfers to internal transfers", () => {
  const next = reclassification(LEGACY_GENERIC_TRANSFER, suggestIncomeCategory("העברה עצמית"));
  assert.deepEqual(next, { category: INTERNAL_TRANSFERS, subCategory: "העברה עצמית" });
});

test("reclassification moves the old generic-transfer category to the new default", () => {
  assert.deepEqual(reclassification(LEGACY_GENERIC_TRANSFER, suggestIncomeCategory("העברה מיוסי")), {
    category: "שונות",
    subCategory: "העברה בנקאית",
  });
});

test("reclassification keeps rows the user categorised", () => {
  // A learned rule matches → the user chose this category.
  const learned = suggestIncomeCategory("העברה עצמית", [
    { description: "העברה עצמית", category: "משכורת", subCategory: "בונוס" },
  ]);
  assert.equal(reclassification({ category: "משכורת", subCategory: "בונוס" }, learned), null);
  // A fixed rule that isn't a transfer never overrides an existing category.
  assert.equal(
    reclassification({ category: "הכנסות מנכסים", subCategory: "ריבית" }, suggestIncomeCategory("משכורת")),
    null,
  );
  // Already in place → nothing to do.
  assert.equal(
    reclassification({ category: INTERNAL_TRANSFERS, subCategory: "העברה עצמית" }, suggestIncomeCategory("העברה עצמית")),
    null,
  );
});
