import { test } from "node:test";
import assert from "node:assert/strict";
import { scraperError } from "../src/scrapeRunner.js";

const creds = { username: "someone", password: "hunter2-secret" };

test("each scraper error type maps to its API code and is passed through", () => {
  const cases: [string, string][] = [
    ["INVALID_PASSWORD", "BANK_INVALID_CREDENTIALS"],
    ["TWO_FACTOR_RETRIEVER_MISSING", "BANK_OTP_REQUIRED"],
    ["CHANGE_PASSWORD", "BANK_CHANGE_PASSWORD"],
    ["ACCOUNT_BLOCKED", "BANK_ACCOUNT_BLOCKED"],
    ["TIMEOUT", "BANK_TIMEOUT"],
    ["GENERAL_ERROR", "BANK_ERROR"],
    ["GENERIC", "BANK_ERROR"],
  ];
  for (const [type, code] of cases) {
    const err = scraperError(type, "", creds);
    assert.equal(err.code, code, type);
    assert.equal(err.details?.scraperErrorType, type);
  }
});

test("a GENERIC Puppeteer timeout counts as a bank timeout", () => {
  const err = scraperError("GENERIC", "Navigation timeout of 60000 ms exceeded", creds);
  assert.equal(err.code, "BANK_TIMEOUT");
  assert.equal(err.details?.scraperErrorType, "GENERIC");
});

test("a missing error type is reported as GENERIC", () => {
  const err = scraperError(undefined, "boom", creds);
  assert.equal(err.code, "BANK_ERROR");
  assert.equal(err.details?.scraperErrorType, "GENERIC");
});

test("credentials are redacted from the internal message", () => {
  const err = scraperError("GENERIC", "failed for someone with hunter2-secret", creds);
  assert.equal(err.details?.internalMessage, "failed for [REDACTED] with [REDACTED]");
});
