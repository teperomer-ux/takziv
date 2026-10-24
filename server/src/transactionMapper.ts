import { createHash } from "node:crypto";
import type { CompanyTypes } from "israeli-bank-scrapers";
import { suggestCategory, type UserMapping } from "../../src/utils/classifier.js";
import { suggestIncomeCategory } from "../../src/utils/incomeClassifier.js";
import { matchCreditCardCompany } from "../../src/utils/bankReconciliation.js";
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

/** A row ready to write to users/{uid}/transactions or users/{uid}/incomeTransactions. */
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

export interface UserMappings {
  expense: UserMapping[];
  income: UserMapping[];
}

export interface MapResult {
  /** Card purchases / direct bank debits → users/{uid}/transactions */
  expenses: MappedTransaction[];
  /** Bank credits (salary, transfers in, …) → users/{uid}/incomeTransactions */
  incomes: MappedTransaction[];
  skippedPending: number;
  /** Bank debits that are the monthly lump-sum credit-card bill. */
  skippedCardPayments: number;
  /** Rows with no amount (or 0): nothing to record in either direction. */
  skippedZeroAmount: number;
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
 * Maps scraper output onto the app's Transaction shape, mirroring how the
 * former file uploaders split the data:
 *  - card accounts: charges positive, refunds negative, billing month from
 *    the charge (processed) date
 *  - bank accounts: credits become incomes; debits that are a credit-card
 *    bill payment are dropped (the card's own transactions already cover
 *    that money); every other debit is a "bank" expense
 *  - pending transactions are skipped — their amount/identifier can still change
 *  - each doc id is a hash of the bank-side identity so re-syncing the same
 *    range never creates duplicates
 */
export function mapScrapedTransactions(
  companyId: CompanyTypes,
  accounts: ScrapedAccount[],
  mappings: UserMappings,
): MapResult {
  const source = SOURCE_BY_COMPANY[companyId];
  const isBank = source === "bank";
  const seen = new Map<string, number>();
  const result: MapResult = { expenses: [], incomes: [], skippedPending: 0, skippedCardPayments: 0, skippedZeroAmount: 0 };

  for (const account of accounts) {
    for (const txn of account.txns) {
      if (txn.status === "pending") {
        result.skippedPending++;
        continue;
      }

      const description = txn.description.trim();
      // The sign is the direction: debits are negative, credits positive.
      // Some scrapers leave chargedAmount empty and only fill originalAmount.
      const charged = Number.isFinite(txn.chargedAmount) ? txn.chargedAmount : txn.originalAmount;
      if (!Number.isFinite(charged) || charged === 0) {
        result.skippedZeroAmount++;
        continue;
      }
      const isIncome = isBank && charged > 0;
      if (isBank && !isIncome && matchCreditCardCompany(description)) {
        result.skippedCardPayments++;
        continue;
      }

      const date = toIsraelYmd(txn.date);
      const [billingYear, billingMonth] = toIsraelYmd(txn.processedDate || txn.date)
        .split("-")
        .map(Number);

      const identity = [
        companyId,
        account.accountNumber,
        txn.identifier ?? "",
        date,
        charged,
        description,
        txn.installments ? `${txn.installments.number}/${txn.installments.total}` : "",
      ].join("|");
      // Two genuinely identical rows on the same day (no bank identifier)
      // are told apart by their order of appearance in the scrape.
      const occurrence = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, occurrence);
      const id = createHash("sha256").update(`${identity}#${occurrence}`).digest("hex").slice(0, 40);

      if (isIncome) {
        const match = suggestIncomeCategory(description, mappings.income);
        result.incomes.push({
          id,
          date,
          description,
          amount: charged,
          category: match?.category ?? "",
          subCategory: match?.subCategory ?? "",
          billingMonth,
          billingYear,
        });
        continue;
      }

      // Scrapers report charges as negative; the app stores them positive.
      const amount = -charged;
      const match = suggestCategory(description, mappings.expense);
      const isCredit = amount < 0;
      result.expenses.push({
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

  return result;
}
