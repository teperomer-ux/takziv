import { createHash } from "node:crypto";
import type { CompanyTypes } from "israeli-bank-scrapers";
import { suggestCategory, type UserMapping } from "../../src/utils/classifier.js";
import type { ScrapedAccount } from "./scrapeRunner.js";

/** Same slugs as `TransactionSource` in src/types/index.ts. */
type TransactionSource = "max" | "isracard" | "cal" | "bank";

const SOURCE_BY_COMPANY: Partial<Record<CompanyTypes, TransactionSource>> = {
  max: "max",
  isracard: "isracard",
  visaCal: "cal",
  hapoalim: "bank",
  leumi: "bank",
  mizrahi: "bank",
  discount: "bank",
  mercantile: "bank",
  otsarHahayal: "bank",
  union: "bank",
  beinleumi: "bank",
  massad: "bank",
  yahav: "bank",
  pagi: "bank",
  oneZero: "bank",
};

/** A transaction ready to write to users/{uid}/transactions/{id}. */
export interface MappedTransaction {
  id: string;
  /** YYYY-MM-DD in Israel time. */
  date: string;
  description: string;
  amount: number;
  category: string;
  subCategory: string;
  billingMonth: number;
  billingYear: number;
  source?: TransactionSource;
}

export interface MapResult {
  transactions: MappedTransaction[];
  skippedPending: number;
  skippedIncome: number;
}

const israelDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Scrapers return ISO timestamps such as "2026-09-03T21:00:00.000Z" for an
 * Israeli calendar day of 2026-09-04, so convert in Asia/Jerusalem rather
 * than slicing the UTC string.
 */
function toIsraelYmd(iso: string): string {
  return israelDate.format(new Date(iso));
}

/**
 * Maps scraper output onto the app's Transaction shape:
 *  - amounts follow the app's convention: charges positive, refunds negative
 *    (scrapers report charges as negative chargedAmount)
 *  - billing month comes from the charge (processed) date
 *  - pending transactions are skipped — their amount/identifier can still change
 *  - for bank accounts only debits are kept; incoming money belongs to income
 *  - each doc id is a hash of the bank-side identity so re-syncing the same
 *    range never creates duplicates
 */
export function mapScrapedTransactions(
  companyId: CompanyTypes,
  accounts: ScrapedAccount[],
  userMappings: UserMapping[],
): MapResult {
  const source = SOURCE_BY_COMPANY[companyId];
  const isBank = source === "bank";
  const seen = new Map<string, number>();
  const transactions: MappedTransaction[] = [];
  let skippedPending = 0;
  let skippedIncome = 0;

  for (const account of accounts) {
    for (const txn of account.txns) {
      if (txn.status === "pending") {
        skippedPending++;
        continue;
      }
      if (isBank && txn.chargedAmount >= 0) {
        skippedIncome++;
        continue;
      }

      const date = toIsraelYmd(txn.date);
      const [billingYear, billingMonth] = toIsraelYmd(txn.processedDate || txn.date)
        .split("-")
        .map(Number);
      const amount = -txn.chargedAmount;
      const description = txn.description.trim();

      const identity = [
        companyId,
        account.accountNumber,
        txn.identifier ?? "",
        date,
        txn.chargedAmount,
        description,
        txn.installments ? `${txn.installments.number}/${txn.installments.total}` : "",
      ].join("|");
      // Two genuinely identical charges on the same day (no bank identifier)
      // are told apart by their order of appearance in the scrape.
      const occurrence = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, occurrence);
      const id = createHash("sha256").update(`${identity}#${occurrence}`).digest("hex").slice(0, 40);

      const match = suggestCategory(description, userMappings);
      const isCredit = amount < 0;

      transactions.push({
        id,
        date,
        description,
        amount,
        category: match?.category ?? (isCredit ? "זיכויים/החזרים" : ""),
        subCategory: match?.subCategory ?? (isCredit ? "החזר כספי" : ""),
        billingMonth,
        billingYear,
        source,
      });
    }
  }

  return { transactions, skippedPending, skippedIncome };
}
