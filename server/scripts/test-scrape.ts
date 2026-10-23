/**
 * Local bank-scrape harness: runs one scrape on this machine (no Docker, no
 * HTTP server) through the same runner, mapper and Firestore writer the API
 * uses.
 *
 *   npm run scrape:test -- --company max                        dry run, prints rows
 *   npm run scrape:test -- --company max --user me@gmail.com --save
 *
 * Credentials are read from a hidden prompt (or TEST_SCRAPE_<FIELD> env vars),
 * kept only in memory, and never accepted as CLI flags so they can't land in
 * shell history.
 */
import { parseArgs } from "node:util";
import { CompanyTypes, SCRAPERS } from "israeli-bank-scrapers";
import { adminAuth } from "../src/firebaseAdmin.js";
import { ApiError } from "../src/errors.js";
import { missingLoginFields } from "../src/scrapeRunner.js";
import { scrapeProvider } from "../src/scraperService.js";
import type { MappedTransaction, UserMappings } from "../src/transactionMapper.js";
import { getUserMappings, saveNewTransactions } from "../src/transactionRepository.js";

const USAGE = `Usage: npm run scrape:test -- --company <id> [options]

  --company <id>    ${["max", "isracard", "amex", "visaCal", "hapoalim", "leumi", "discount", "mizrahi"].join(", ")}, …
  --since <date>    YYYY-MM-DD, default 30 days ago
  --until <date>    YYYY-MM-DD, default today
  --user <who>      Firebase uid or Google e-mail; needed for --save (and to use learned categories)
  --save            write new rows to users/{uid}/transactions as drafts (default: dry run)
  --show-browser    run Chromium with a visible window
  --limit <n>       rows to print per table, default 50`;

const { values: args } = parseArgs({
  options: {
    company: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    user: { type: "string" },
    save: { type: "boolean", default: false },
    "show-browser": { type: "boolean", default: false },
    limit: { type: "string", default: "50" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const SECRET_FIELDS = new Set(["password", "card6Digits", "otpLongTermToken"]);

/** Reads a line from the terminal; secret input is echoed as '*'. */
function prompt(label: string, secret: boolean): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    fail(
      "No interactive terminal for the credential prompt.\n" +
        "  Run from PowerShell / Windows Terminal (Git Bash's mintty can't hide input),\n" +
        "  or set TEST_SCRAPE_<FIELD> variables in server/.env.",
    );
  }
  stdout.write(`${label}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          stdout.write("\n");
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolve(value);
        } else if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
        } else {
          value += ch;
          stdout.write(secret ? "*" : ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readCredentials(companyId: CompanyTypes) {
  const credentials: Record<string, string> = {};
  for (const field of SCRAPERS[companyId].loginFields) {
    const envName = `TEST_SCRAPE_${field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    credentials[field] = process.env[envName] || (await prompt(`  ${field}`, SECRET_FIELDS.has(field)));
    delete process.env[envName];
  }
  return credentials;
}

async function resolveUid(user: string) {
  try {
    return user.includes("@") ? (await adminAuth.getUserByEmail(user)).uid : (await adminAuth.getUser(user)).uid;
  } catch (err) {
    fail(`Could not find Firebase user "${user}": ${(err as Error).message}`);
  }
}

const ddmmyyyy = (ymd: string) => ymd.split("-").reverse().join("/");

function printRows(title: string, rows: MappedTransaction[], limit: number) {
  console.log(`\n${title} (${rows.length})`);
  if (!rows.length) return;
  console.table(
    rows.slice(0, limit).map((r) => ({
      source: r.source ?? "bank",
      amount: r.amount.toFixed(2),
      date: ddmmyyyy(r.date),
      businessName: r.description,
      category: r.category || "—",
    })),
  );
  if (rows.length > limit) console.log(`  … ${rows.length - limit} more (use --limit)`);
}

async function main() {
  if (args.help) return console.log(USAGE);

  const companyId = args.company as CompanyTypes;
  if (!companyId || !Object.values(CompanyTypes).includes(companyId)) {
    fail(`--company must be one of: ${Object.values(CompanyTypes).join(", ")}\n\n${USAGE}`);
  }
  if (args.save && !args.user) fail("--save needs --user <uid|e-mail> to know whose transactions to write.");

  const since = args.since ? new Date(args.since) : new Date(Date.now() - 30 * 86_400_000);
  if (Number.isNaN(since.getTime()) || since > new Date()) fail("--since must be a past YYYY-MM-DD date.");
  const until = args.until ? new Date(args.until) : undefined;
  if (until && (Number.isNaN(until.getTime()) || until < since)) fail("--until must be a YYYY-MM-DD date after --since.");
  const limit = Number(args.limit) || 50;

  // Resolve the user before asking for bank credentials, so a typo fails fast.
  const uid = args.user ? await resolveUid(args.user) : undefined;

  console.log(`\n${SCRAPERS[companyId].name} — since ${since.toISOString().slice(0, 10)}`);
  console.log(uid ? `Firebase user: ${uid}${args.save ? "" : " (dry run)"}` : "No --user: dry run, built-in categories only");
  console.log("Login details (kept in memory only):");

  let credentials: Record<string, string> | undefined = await readCredentials(companyId);
  const missing = missingLoginFields(companyId, credentials);
  if (missing.length) fail(`Missing login fields: ${missing.join(", ")}`);

  console.log(`\nLaunching Chromium${args["show-browser"] ? " (visible)" : " (headless)"} and logging in…`);
  const startedAt = Date.now();
  const mappings: UserMappings = uid ? await getUserMappings(uid) : { expense: [], income: [] };
  let outcome;
  try {
    const request = { provider: companyId, credentials, startDate: since, endDate: until, headless: !args["show-browser"] };
    credentials = undefined;
    outcome = await scrapeProvider(request, mappings);
  } catch (err) {
    if (err instanceof ApiError) {
      // internalMessage was already redacted of credential values by the runner.
      const { internalMessage, ...rest } = err.details ?? {};
      fail(`Scrape failed: ${err.code} ${JSON.stringify(rest)}${internalMessage ? `\n  ${internalMessage}` : ""}`);
    }
    throw err;
  }
  console.log(`✔ Scraped in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  for (const a of outcome.accounts) {
    console.log(`  account ${a.accountNumber}${a.balance != null ? `: balance ${a.balance}` : ""}`);
  }

  const { expenses, incomes } = outcome;
  printRows("Expenses → users/{uid}/transactions", expenses, limit);
  printRows("Incomes → users/{uid}/incomeTransactions", incomes, limit);
  console.log(
    `\nSkipped: ${outcome.skippedPending} pending, ${outcome.skippedCardPayments} credit-card bill payments, ` +
      `${outcome.skippedOutOfRange} after --until`,
  );

  if (!args.save || !uid) {
    console.log("\nDry run — nothing written. Add --user <uid|e-mail> --save to store these as drafts.\n");
    return;
  }

  const e = await saveNewTransactions(uid, "transactions", expenses);
  const i = await saveNewTransactions(uid, "incomeTransactions", incomes);
  console.log(`\n✔ Saved ${e.inserted} expenses + ${i.inserted} incomes as drafts`);
  console.log(`  ${e.duplicateById + i.duplicateById} already saved by an earlier sync`);
  console.log(`  ${e.dismissed + i.dismissed} deleted earlier in the app (not re-imported)`);
  console.log(`  ${e.duplicateByContent + i.duplicateByContent} already present from a file upload (same date + amount + business)`);

  // Prove the duplicate protection: re-writing the same rows must insert nothing.
  const again =
    (await saveNewTransactions(uid, "transactions", expenses)).inserted +
    (await saveNewTransactions(uid, "incomeTransactions", incomes)).inserted;
  if (again !== 0) fail(`Duplicate check FAILED: re-saving inserted ${again} rows`);
  console.log("✔ Duplicate check: re-saving the same rows inserted 0\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
