import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidStartDate, needsBackfill, syncWindow } from "../src/connectionSync.js";

const now = new Date("2026-10-24T09:00:00Z");
const day = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

test("start dates: today and up to a year back are valid", () => {
  assert.equal(isValidStartDate("2026-10-24", now), true);
  assert.equal(isValidStartDate("2026-01-01", now), true);
  assert.equal(isValidStartDate(ymd(new Date(now.getTime() - 365 * day)), now), true);
});

test("start dates: future, too old, malformed and impossible dates are rejected", () => {
  assert.equal(isValidStartDate("2026-10-25", now), false);
  assert.equal(isValidStartDate(ymd(new Date(now.getTime() - 367 * day)), now), false);
  assert.equal(isValidStartDate("24/10/2026", now), false);
  assert.equal(isValidStartDate("2026-02-31", now), false);
  assert.equal(isValidStartDate("", now), false);
});

test("backfill is pending only when the start date is before what was fetched", () => {
  assert.equal(needsBackfill({ startDate: null, syncedFrom: null }), false);
  assert.equal(needsBackfill({ startDate: "2026-01-01", syncedFrom: null }), true);
  assert.equal(needsBackfill({ startDate: "2026-01-01", syncedFrom: "2026-09-01" }), true);
  assert.equal(needsBackfill({ startDate: "2026-09-01", syncedFrom: "2026-09-01" }), false);
  assert.equal(needsBackfill({ startDate: "2026-10-01", syncedFrom: "2026-09-01" }), false);
});

test("a start date moved earlier backfills from it and records the new earliest date", () => {
  const w = syncWindow({ startDate: "2026-01-01", syncedFrom: "2026-09-01", lastSyncAt: new Date("2026-10-23") }, undefined, now);
  assert.equal(ymd(w.start), "2026-01-01");
  assert.equal(w.fetchedFrom, "2026-01-01");
});

test("after backfilling, syncs are incremental: last sync minus 7 days", () => {
  const w = syncWindow({ startDate: "2026-01-01", syncedFrom: "2026-01-01", lastSyncAt: new Date("2026-10-23T00:00:00Z") }, undefined, now);
  assert.equal(ymd(w.start), "2026-10-16");
  assert.equal(w.fetchedFrom, undefined);
});

test("the incremental window never goes before a later start date", () => {
  const w = syncWindow({ startDate: "2026-10-20", syncedFrom: "2026-09-01", lastSyncAt: new Date("2026-10-23T00:00:00Z") }, undefined, now);
  assert.equal(ymd(w.start), "2026-10-20");
});

test("an override wins for that sync, and only moves syncedFrom when it reaches further back", () => {
  const c = { startDate: "2026-09-01", syncedFrom: "2026-09-01", lastSyncAt: new Date("2026-10-23") };
  const earlier = syncWindow(c, "2026-03-01", now);
  assert.equal(ymd(earlier.start), "2026-03-01");
  assert.equal(earlier.fetchedFrom, "2026-03-01");

  const later = syncWindow(c, "2026-10-01", now);
  assert.equal(ymd(later.start), "2026-10-01");
  assert.equal(later.fetchedFrom, undefined);
});

test("connections saved before start dates existed keep the old behaviour", () => {
  const w = syncWindow({ startDate: null, syncedFrom: null, lastSyncAt: new Date("2026-10-23T00:00:00Z") }, undefined, now);
  assert.equal(ymd(w.start), "2026-10-16");
  assert.equal(w.fetchedFrom, undefined);
});
