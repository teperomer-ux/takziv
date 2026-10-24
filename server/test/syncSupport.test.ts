import { test } from "node:test";
import assert from "node:assert/strict";
import { SYNC_STALE_AFTER_MS, acquireBrowserSlot, isSyncDue } from "../src/syncSupport.js";

test("browser slots are capped and freed on release", () => {
  const a = acquireBrowserSlot(2);
  const b = acquireBrowserSlot(2);
  assert.ok(a && b);
  assert.equal(acquireBrowserSlot(2), null);

  a();
  const c = acquireBrowserSlot(2);
  assert.ok(c);
  b();
  c();
});

test("releasing a slot twice frees it only once", () => {
  const a = acquireBrowserSlot(1);
  assert.ok(a);
  a();
  a();
  const b = acquireBrowserSlot(1);
  assert.ok(b);
  // If the double release had counted twice, a second slot would be free here.
  assert.equal(acquireBrowserSlot(1), null);
  b();
});

test("a connection that never synced is due", () => {
  assert.equal(isSyncDue(null), true);
});

test("a connection is due only once its last sync is older than the threshold", () => {
  const now = new Date("2026-10-24T06:00:00Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  assert.equal(isSyncDue(at(SYNC_STALE_AFTER_MS - 60_000), now), false);
  assert.equal(isSyncDue(at(SYNC_STALE_AFTER_MS), now), false);
  assert.equal(isSyncDue(at(SYNC_STALE_AFTER_MS + 60_000), now), true);
});
