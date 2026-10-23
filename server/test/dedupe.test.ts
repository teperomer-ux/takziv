import { test } from "node:test";
import assert from "node:assert/strict";
import { contentKey, findContentDuplicates, type ExistingRow } from "../src/dedupe.js";
import type { MappedTransaction } from "../src/transactionMapper.js";

function scraped(id: string, overrides: Partial<MappedTransaction> = {}): MappedTransaction {
  return {
    id,
    date: "2026-09-04",
    description: "שופרסל דיל",
    amount: 120,
    category: "",
    subCategory: "",
    billingMonth: 10,
    billingYear: 2026,
    source: "max",
    ...overrides,
  };
}

function uploaded(id: string, overrides: Partial<ExistingRow> = {}): ExistingRow {
  return { id, date: "2026-09-04", description: "שופרסל דיל", amount: 120, ...overrides };
}

test("key ignores case, spacing and Hebrew vs ASCII quote marks", () => {
  assert.equal(contentKey("2026-09-04", 99.9, ' סופר  פארם בע"מ '), contentKey("2026-09-04", 99.9, "סופר פארם בע״מ"));
  assert.equal(contentKey("2026-09-04", 1, "AM:PM"), contentKey("2026-09-04", 1, "am:pm"));
});

test("key distinguishes date, amount to the agora, and business", () => {
  const base = contentKey("2026-09-04", 120, "פז");
  assert.notEqual(base, contentKey("2026-09-05", 120, "פז"));
  assert.notEqual(base, contentKey("2026-09-04", 120.01, "פז"));
  assert.notEqual(base, contentKey("2026-09-04", 120, "דלק"));
});

test("a row already uploaded from CSV is a duplicate", () => {
  const dupes = findContentDuplicates([scraped("a")], [uploaded("csv-1", { source: "max" })]);
  assert.deepEqual([...dupes], ["a"]);
});

test("legacy rows without a source match any provider", () => {
  assert.equal(findContentDuplicates([scraped("a")], [uploaded("csv-1")]).size, 1);
  assert.equal(findContentDuplicates([scraped("a")], [uploaded("csv-1", { source: "credit-card" })]).size, 1);
});

test("the same purchase on a different card is not a duplicate", () => {
  assert.equal(findContentDuplicates([scraped("a")], [uploaded("csv-1", { source: "isracard" })]).size, 0);
});

test("matching is one-to-one: two identical coffees vs one uploaded", () => {
  const dupes = findContentDuplicates([scraped("a"), scraped("b")], [uploaded("csv-1")]);
  assert.deepEqual([...dupes], ["a"]);
});

test("nothing matches when nothing exists", () => {
  assert.equal(findContentDuplicates([scraped("a")], []).size, 0);
});
