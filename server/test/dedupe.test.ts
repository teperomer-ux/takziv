import { test } from "node:test";
import assert from "node:assert/strict";
import { contentKey, findContentDuplicates, planDuplicateCleanup, type ExistingRow, type StoredRow } from "../src/dedupe.js";
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

function stored(id: string, overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id,
    date: "2026-05-13",
    description: "הע. לשרה אבבה בסניף 12-668",
    amount: 4300,
    source: "bank",
    synced: false,
    category: "דיור",
    subCategory: 'שכ"ד / משכנתא',
    ...overrides,
  };
}

test("a statement uploaded four times collapses to one row, keeping the edited copy", () => {
  const plan = planDuplicateCleanup([
    stored("a"),
    stored("b"),
    stored("c", { subCategory: "דירה להשקעה - חולון" }),
    stored("d"),
    stored("other", { description: "מכבי חיוב", amount: 96.61 }),
  ]);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].kept.id, "c");
  assert.deepEqual(plan.groups[0].removed.map((r) => r.id).sort(), ["a", "b", "d"]);
  assert.deepEqual(plan.review, []);
});

test("a synced copy is the one kept — its id is what the next sync looks for", () => {
  const plan = planDuplicateCleanup([stored("upload-1"), stored("sync-1", { synced: true }), stored("upload-2")]);
  assert.equal(plan.groups[0].kept.id, "sync-1");
});

test("rows the bank itself reported twice are left for review, not deleted", () => {
  const twins = [stored("s1", { synced: true }), stored("s2", { synced: true })];
  assert.deepEqual(planDuplicateCleanup(twins), { groups: [], review: [twins] });
  // Uploaded copies of a day the sync shows two such charges on are kept too.
  const plan = planDuplicateCleanup([
    stored("u1", { source: undefined, description: "טעינות קניה אינט" }),
    stored("u2", { source: undefined, description: "טעינות קניה אינט" }),
    stored("s1", { synced: true, source: "isracard", description: "טעינות" }),
    stored("s2", { synced: true, source: "isracard", description: "טעינות" }),
  ]);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.review.length, 2);
});

test("different providers or amounts are never copies of each other", () => {
  const plan = planDuplicateCleanup([stored("a"), stored("b", { source: "max" }), stored("c", { amount: 4300.01 })]);
  assert.deepEqual(plan, { groups: [], review: [] });
});

test("re-syncing over leftover upload copies inserts nothing", () => {
  const legacy = ["u1", "u2", "u3", "u4"].map((id) =>
    uploaded(id, { description: "הע. לשרה אבבה בסניף 12-668", amount: 4300, date: "2026-05-13", source: "bank" }),
  );
  const tx = scraped("sync", { description: "הע. לשרה אבבה בסניף 12-668", amount: 4300, date: "2026-05-13", source: "bank" });
  assert.deepEqual([...findContentDuplicates([tx], legacy)], ["sync"]);
});
