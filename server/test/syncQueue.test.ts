import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireBrowserSlot, browserSlotStats, waitForBrowserSlot } from "../src/syncSupport.js";

test("a free slot is granted at once", async () => {
  const release = await waitForBrowserSlot(1_000, 1);
  assert.ok(release);
  release();
});

test("a second request waits for the first to finish instead of failing", async () => {
  const first = await waitForBrowserSlot(1_000, 1);
  assert.ok(first);
  let granted = false;
  const second = waitForBrowserSlot(5_000, 1).then((r) => {
    granted = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(granted, false, "must not run while the slot is taken");
  assert.equal(browserSlotStats().queued, 1);

  first();
  const release = await second;
  assert.ok(release);
  assert.equal(browserSlotStats().queued, 0);
  release();
});

test("waiters are served in arrival order", async () => {
  const holder = await waitForBrowserSlot(1_000, 1);
  assert.ok(holder);
  const order: string[] = [];
  const a = waitForBrowserSlot(5_000, 1).then((r) => (order.push("a"), r));
  const b = waitForBrowserSlot(5_000, 1).then((r) => (order.push("b"), r));
  holder();
  const ra = await a;
  ra!();
  const rb = await b;
  rb!();
  assert.deepEqual(order, ["a", "b"]);
});

test("a queued request gives up after its wait and leaves the queue", async () => {
  const holder = await waitForBrowserSlot(1_000, 1);
  assert.ok(holder);
  const started = Date.now();
  const release = await waitForBrowserSlot(50, 1);
  assert.equal(release, null);
  assert.ok(Date.now() - started >= 45);
  assert.equal(browserSlotStats().queued, 0);
  holder();
});

test("an immediate acquire doesn't jump ahead of queued requests", async () => {
  const holder = await waitForBrowserSlot(1_000, 1);
  assert.ok(holder);
  const queued = waitForBrowserSlot(5_000, 1);
  holder();
  // The freed slot went to the waiter, synchronously, not to a newcomer.
  assert.equal(acquireBrowserSlot(1), null);
  (await queued)!();
  assert.equal(browserSlotStats().active, 0);
});

test("a released slot is only handed off once, however often release is called", async () => {
  const holder = await waitForBrowserSlot(1_000, 1);
  assert.ok(holder);
  const next = waitForBrowserSlot(5_000, 1);
  holder();
  holder();
  const r = await next;
  assert.equal(browserSlotStats().active, 1);
  r!();
  assert.equal(browserSlotStats().active, 0);
});
