import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cookie } from "puppeteer";
import {
  MAX_SESSION_AGE_MS,
  MAX_SESSION_BYTES,
  SESSION_VERSION,
  isUsableSession,
  persistentCookies,
  sessionFits,
  type BrowserSession,
} from "../src/browserSession.js";

const now = Date.parse("2026-11-11T08:00:00Z");
const inOneYear = (now + 365 * 86_400_000) / 1000;

function cookie(overrides: Partial<Cookie>): Cookie {
  return {
    name: "device",
    value: "abc",
    domain: ".bank.example",
    path: "/",
    expires: inOneYear,
    size: 9,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: "Lax",
    ...overrides,
  };
}

test("only unexpired persistent cookies are kept; session and expired ones are dropped", () => {
  const kept = persistentCookies(
    [
      cookie({ name: "trusted-device" }),
      cookie({ name: "login-session", expires: -1, session: true }),
      cookie({ name: "stale", expires: (now - 1000) / 1000 }),
    ],
    now,
  );
  assert.deepEqual(
    kept.map((c) => c.name),
    ["trusted-device"],
  );
});

test("read-only cookie state is stripped so the record can be fed back to setCookie", () => {
  const [kept] = persistentCookies([cookie({})], now);
  assert.ok(!("size" in kept));
  assert.ok(!("session" in kept));
  assert.equal(kept.expires, inOneYear);
  assert.equal(kept.httpOnly, true);
});

function session(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    v: SESSION_VERSION,
    savedAt: now,
    cookies: [{ name: "device", value: "abc", domain: ".bank.example", expires: inOneYear }],
    localStorage: {},
    ...overrides,
  };
}

test("a session is usable when recent and non-empty", () => {
  assert.equal(isUsableSession(session(), now), true);
  assert.equal(isUsableSession(session({ cookies: [], localStorage: { "https://bank.example": { id: "1" } } }), now), true);
});

test("empty, stale, malformed or foreign-version sessions are not restored", () => {
  assert.equal(isUsableSession(session({ cookies: [], localStorage: {} }), now), false);
  assert.equal(isUsableSession(session({ savedAt: now - MAX_SESSION_AGE_MS - 1 }), now), false);
  assert.equal(isUsableSession({ ...session(), v: 99 }, now), false);
  assert.equal(isUsableSession(null, now), false);
  assert.equal(isUsableSession("cookies", now), false);
});

test("a runaway session is refused instead of pushing the document over its size limit", () => {
  assert.equal(sessionFits(session()), true);
  const huge = session({ localStorage: { "https://bank.example": { blob: "x".repeat(MAX_SESSION_BYTES) } } });
  assert.equal(sessionFits(huge), false);
});
