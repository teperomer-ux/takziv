import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyTypes } from "israeli-bank-scrapers";
import { chargedIls, isIls, mapScrapedTransactions } from "../src/transactionMapper.js";
import { findContentDuplicates, planDuplicateCleanup, type StoredRow } from "../src/dedupe.js";
import { syncWindow } from "../src/connectionSync.js";
import { toConnection } from "../src/connectionRepository.js";
import { BROWSER_ARGS, desktopUserAgent, isTransientScrapeError } from "../src/scrapeRunner.js";
import { ApiError } from "../src/errors.js";
import type { ScrapedAccount } from "../src/scrapeRunner.js";

type Txn = ScrapedAccount["txns"][number];
const noMappings = { expense: [], income: [] };

function account(txns: Partial<Txn>[]): ScrapedAccount {
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

// ── Pending and foreign currency ────────────────────────────────────────────

test("a foreign purchase not yet charged in ILS is held back as pending, never stored in dollars", () => {
  const r = mapScrapedTransactions(
    CompanyTypes.max,
    [account([{ chargedAmount: 0, originalAmount: -50, originalCurrency: "USD", date: "2026-08-20T21:00:00.000Z" }])],
    noMappings,
  );
  assert.equal(r.expenses.length, 0);
  assert.equal(r.skippedPending, 1);
  assert.equal(r.oldestPendingDate, "2026-08-21");
});

test("a charged foreign purchase is stored in ILS and keeps the original amount and currency", () => {
  const [tx] = mapScrapedTransactions(
    CompanyTypes.isracard,
    [account([{ chargedAmount: -187.4, originalAmount: -50, originalCurrency: "USD", description: "AMAZON" }])],
    noMappings,
  ).expenses;
  assert.equal(tx.amount, 187.4);
  assert.deepEqual(tx.original, { amount: 50, currency: "USD" });
});

test("shekel rows carry no original-currency info", () => {
  const [tx] = mapScrapedTransactions(CompanyTypes.max, [account([{}])], noMappings).expenses;
  assert.equal(tx.original, undefined);
});

test("oldestPendingDate is the earliest pending row, null when nothing is pending", () => {
  const pending = "pending" as Txn["status"];
  const r = mapScrapedTransactions(
    CompanyTypes.max,
    [
      account([
        { status: pending, date: "2026-09-10T21:00:00.000Z" },
        { status: pending, date: "2026-09-01T21:00:00.000Z" },
        {},
      ]),
    ],
    noMappings,
  );
  assert.equal(r.oldestPendingDate, "2026-09-02");
  assert.equal(mapScrapedTransactions(CompanyTypes.max, [account([{}])], noMappings).oldestPendingDate, null);
});

test("chargedIls: explicit 0 in shekels is nothing; an empty charge falls back to the shekel original", () => {
  assert.equal(chargedIls({ chargedAmount: 0, originalAmount: -30, originalCurrency: "ILS" }), 0);
  assert.equal(chargedIls({ chargedAmount: undefined as unknown as number, originalAmount: -30, originalCurrency: "₪" }), -30);
  assert.equal(chargedIls({ chargedAmount: undefined as unknown as number, originalAmount: -30, originalCurrency: "EUR" }), "unconverted");
  assert.ok(isIls("ils") && isIls('ש"ח') && isIls(undefined) && !isIls("USD"));
});

test("ids of already-stored rows don't change (the dedupe key stays stable)", () => {
  // Same inputs as the original mapper: a plain ILS charge.
  const a = mapScrapedTransactions(CompanyTypes.max, [account([{}])], noMappings).expenses[0].id;
  const b = mapScrapedTransactions(CompanyTypes.max, [account([{ originalCurrency: "ILS" }])], noMappings).expenses[0].id;
  assert.equal(a, b);
});

// ── Installments (עסקאות תשלומים) ───────────────────────────────────────────

function installment(n: number, billingMonth: number) {
  return account([
    {
      type: "installments" as Txn["type"],
      date: "2026-06-14T21:00:00.000Z",
      processedDate: `2026-${String(billingMonth).padStart(2, "0")}-01T21:00:00.000Z`,
      chargedAmount: -300,
      originalAmount: -3600,
      description: "KSP",
      installments: { number: n, total: 12 },
    },
  ]);
}

test("each installment payment gets its own id and carries n/N", () => {
  const p2 = mapScrapedTransactions(CompanyTypes.max, [installment(2, 8)], noMappings).expenses[0];
  const p3 = mapScrapedTransactions(CompanyTypes.max, [installment(3, 9)], noMappings).expenses[0];
  assert.notEqual(p2.id, p3.id);
  assert.deepEqual(p3.installment, { number: 3, total: 12 });
  assert.equal(p3.date, p2.date, "payments share the purchase date");
});

test("a new installment payment is not swallowed as a duplicate of last month's payment", () => {
  const p3 = mapScrapedTransactions(CompanyTypes.max, [installment(3, 9)], noMappings).expenses[0];
  // Payment 2, saved by last month's sync, with the n/N marker…
  const marked = { id: "p2", date: p3.date, amount: 300, description: "KSP", source: "max", billingMonth: 8, billingYear: 2026, installment: "2/12" };
  assert.equal(findContentDuplicates([p3], [marked]).size, 0);
  // …or saved before the marker existed (billing month only).
  const { installment: _, ...legacy } = marked;
  assert.equal(findContentDuplicates([p3], [legacy]).size, 0);
});

test("the same installment payment uploaded from a statement is still a duplicate", () => {
  const p3 = mapScrapedTransactions(CompanyTypes.max, [installment(3, 9)], noMappings).expenses[0];
  const uploaded = { id: "csv", date: p3.date, amount: 300, description: "KSP", source: "max", billingMonth: 9, billingYear: 2026 };
  assert.deepEqual([...findContentDuplicates([p3], [uploaded])], [p3.id]);
});

test("an installment never matches a row whose billing month is unknown", () => {
  const p3 = mapScrapedTransactions(CompanyTypes.max, [installment(3, 9)], noMappings).expenses[0];
  assert.equal(findContentDuplicates([p3], [{ id: "x", date: p3.date, amount: 300, description: "KSP" }]).size, 0);
});

test("the duplicate cleanup keeps installment payments billed in different months", () => {
  const row = (id: string, billingMonth: number): StoredRow => ({
    id,
    date: "2026-06-15",
    amount: 300,
    description: "KSP",
    source: "max",
    billingMonth,
    billingYear: 2026,
    synced: false,
    category: "",
    subCategory: "",
  });
  const plan = planDuplicateCleanup([row("a", 7), row("b", 8), row("c", 9)]);
  assert.equal(plan.groups.length, 0);
  // Two uploads of the same month's statement are still collapsed.
  assert.equal(planDuplicateCleanup([row("a", 7), row("a2", 7)]).groups.length, 1);
});

// ── Sync window reaches back to pending rows ────────────────────────────────

test("the incremental window reaches back to the oldest row that was pending", () => {
  const now = new Date("2026-10-24T09:00:00Z");
  const base = { startDate: "2026-01-01", syncedFrom: "2026-01-01", lastSyncAt: new Date("2026-10-23T00:00:00Z") };
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  assert.equal(ymd(syncWindow(base, undefined, now).start), "2026-10-16");
  assert.equal(ymd(syncWindow({ ...base, pendingFrom: "2026-10-02" }, undefined, now).start), "2026-10-02");
  // A pending date inside the overlap changes nothing; one before the start date is clamped to it.
  assert.equal(ymd(syncWindow({ ...base, pendingFrom: "2026-10-20" }, undefined, now).start), "2026-10-16");
  assert.equal(
    ymd(syncWindow({ ...base, startDate: "2026-10-10", pendingFrom: "2026-09-01" }, undefined, now).start),
    "2026-10-10",
  );
});

test("pendingFrom is read from the connection doc", () => {
  assert.equal(toConnection("c", { companyId: "max", status: "active", pendingFrom: "2026-10-02" }).pendingFrom, "2026-10-02");
  assert.equal(toConnection("c", { companyId: "max", status: "active" }).pendingFrom, null);
});

// ── Browser setup ───────────────────────────────────────────────────────────

test("the browser presents as an ordinary Hebrew desktop Chrome", () => {
  assert.ok(BROWSER_ARGS.includes("--lang=he-IL"));
  assert.ok(BROWSER_ARGS.includes("--disable-blink-features=AutomationControlled"));
  assert.equal(
    desktopUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36"),
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  );
});

test("only network-level failures are retried, never bank answers or timeouts", () => {
  const generic = (msg: string) => new ApiError("BANK_ERROR", { scraperErrorType: "GENERIC", internalMessage: msg });
  assert.equal(isTransientScrapeError(generic("net::ERR_CONNECTION_RESET at https://www.max.co.il")), true);
  assert.equal(isTransientScrapeError(generic("Protocol error (Runtime.callFunctionOn): Target closed")), true);
  assert.equal(isTransientScrapeError(generic("Waiting for selector `#login` failed")), false);
  assert.equal(isTransientScrapeError(new ApiError("BANK_TIMEOUT", { internalMessage: "net::ERR_TIMED_OUT" })), false);
  assert.equal(isTransientScrapeError(new ApiError("BANK_INVALID_CREDENTIALS")), false);
  assert.equal(isTransientScrapeError(new Error("net::ERR_FAILED")), false);
});
