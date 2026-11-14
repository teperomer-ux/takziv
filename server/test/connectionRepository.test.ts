import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { toConnection } from "../src/connectionRepository.js";

const now = Date.parse("2026-11-14T10:00:00Z");
const base = { companyId: "max", maskedLogin: "•••789", lastErrorCode: null };

test("a connection saved but not yet logged in to reads as syncing", () => {
  assert.equal(toConnection("a", { ...base, status: "syncing" }, now).status, "syncing");
  assert.equal(toConnection("a", { ...base, status: "needs_attention" }, now).status, "needs_attention");
  assert.equal(toConnection("a", { ...base, status: "active" }, now).status, "active");
});

test("docs with no or an unknown status read as active, as before", () => {
  assert.equal(toConnection("a", { ...base }, now).status, "active");
  assert.equal(toConnection("a", { ...base, status: "bogus" }, now).status, "active");
});

test("syncInProgress follows the sync lease, not the status", () => {
  const held = Timestamp.fromMillis(now + 60_000);
  const expired = Timestamp.fromMillis(now - 1);
  assert.equal(toConnection("a", { ...base, status: "syncing", syncLockUntil: held }, now).syncInProgress, true);
  assert.equal(toConnection("a", { ...base, status: "syncing", syncLockUntil: expired }, now).syncInProgress, false);
  assert.equal(toConnection("a", { ...base, status: "syncing", syncLockUntil: null }, now).syncInProgress, false);
  assert.equal(toConnection("a", { ...base, status: "active" }, now).syncInProgress, false);
});

test("loginVerified: new credentials start unverified until the bank accepts them", () => {
  assert.equal(toConnection("a", { ...base, status: "syncing", loginVerified: false }, now).loginVerified, false);
  assert.equal(toConnection("a", { ...base, status: "syncing", loginVerified: true }, now).loginVerified, true);
});

test("loginVerified: docs saved before the field existed count as verified only if active", () => {
  assert.equal(toConnection("a", { ...base, status: "active" }, now).loginVerified, true);
  assert.equal(toConnection("a", { ...base }, now).loginVerified, true);
  assert.equal(toConnection("a", { ...base, status: "needs_attention" }, now).loginVerified, false);
  assert.equal(toConnection("a", { ...base, status: "syncing" }, now).loginVerified, false);
});
