/**
 * Removes duplicate copies of the same transaction — left over from the
 * former file uploader, which gave every row a random id, so a statement
 * uploaded twice was stored twice. See planDuplicateCleanup for what counts
 * as a copy and which one is kept.
 *
 *   npm run dedupe:tx -- --user me@gmail.com                       dry run, all months
 *   npm run dedupe:tx -- --user me@gmail.com --from 2026-03 --to 2026-05
 *   npm run dedupe:tx -- --user me@gmail.com --apply               delete the extra copies
 *
 * --apply first writes every doc it deletes to server/.secrets/ (gitignored)
 * so the cleanup can be undone by hand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../src/firebaseAdmin.js";
import { planDuplicateCleanup, type StoredRow } from "../src/dedupe.js";
import type { TargetCollection } from "../src/transactionRepository.js";

const USAGE = `Usage: npm run dedupe:tx -- --user <uid|email> [--from YYYY-MM] [--to YYYY-MM] [--apply]`;

const { values: args } = parseArgs({
  options: {
    user: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!args.user) fail(USAGE);
for (const month of [args.from, args.to]) {
  if (month && !/^\d{4}-\d{2}$/.test(month)) fail(USAGE);
}

async function resolveUid(user: string) {
  try {
    return user.includes("@") ? (await adminAuth.getUserByEmail(user)).uid : (await adminAuth.getUser(user)).uid;
  } catch (err) {
    fail(`Could not find Firebase user "${user}": ${(err as Error).message}`);
  }
}

/** Rows grouped by billing month, so a statement's copies land in the same month as the app shows them. */
function inMonthRange(data: FirebaseFirestore.DocumentData, date: string) {
  const ym = data.billingYear && data.billingMonth
    ? `${data.billingYear}-${String(data.billingMonth).padStart(2, "0")}`
    : date.slice(0, 7);
  return (!args.from || ym >= args.from) && (!args.to || ym <= args.to);
}

async function main() {
  const uid = await resolveUid(args.user!);
  const backup: Record<string, unknown>[] = [];
  const deletions: FirebaseFirestore.DocumentReference[] = [];

  for (const collection of ["transactions", "incomeTransactions"] satisfies TargetCollection[]) {
    const snapshot = await adminDb.collection("users").doc(uid).collection(collection).get();
    const docs = new Map(snapshot.docs.map((d) => [d.id, d]));
    const rows: StoredRow[] = [];
    for (const d of snapshot.docs) {
      const data = d.data();
      const date = (data.date as Timestamp).toDate().toISOString().slice(0, 10);
      if (!inMonthRange(data, date)) continue;
      rows.push({
        id: d.id,
        date,
        amount: Number(data.amount ?? 0),
        description: String(data.description ?? ""),
        source: typeof data.source === "string" ? data.source : undefined,
        synced: data.importedFrom === "bank-sync",
        category: String(data.category ?? ""),
        subCategory: String(data.subCategory ?? ""),
      });
    }

    const plan = planDuplicateCleanup(rows);
    console.log(`\n${collection}: ${rows.length} rows, ${plan.groups.length} duplicated transactions`);
    for (const { kept, removed } of plan.groups) {
      console.log(
        `  ${kept.date}  ${kept.amount.toLocaleString("he-IL")} ₪  ${kept.description}` +
          `\n    keep ${kept.id} (${kept.category || "ללא קטגוריה"} / ${kept.subCategory || "—"}), delete ${removed.length}`,
      );
      for (const r of removed) {
        backup.push({ collection, id: r.id, ...docs.get(r.id)!.data() });
        deletions.push(docs.get(r.id)!.ref);
      }
    }
    for (const group of plan.review) {
      console.log(
        `  [left alone — the bank reported it ${group.length}×, may be separate transactions] ` +
          `${group[0].date}  ${group[0].amount} ₪  ${group[0].description}`,
      );
    }
  }

  if (!deletions.length) return console.log("\nNo duplicates to remove.");
  if (!args.apply) return console.log(`\nDry run: ${deletions.length} rows would be deleted. Re-run with --apply.`);

  const dir = new URL("../../../.secrets/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`dedupe-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, dir);
  writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`\nBackup of the deleted rows: ${file.pathname}`);

  for (let i = 0; i < deletions.length; i += 500) {
    const batch = adminDb.batch();
    for (const ref of deletions.slice(i, i + 500)) batch.delete(ref);
    await batch.commit();
  }
  console.log(`Deleted ${deletions.length} duplicate rows.`);
}

main().catch((err) => fail(String(err)));
