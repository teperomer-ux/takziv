import type { CompanyTypes } from "israeli-bank-scrapers";
import { ApiError } from "./errors.js";
import { missingLoginFields, runScrape } from "./scrapeRunner.js";
import { mapScrapedTransactions, type MapResult, type UserMappings } from "./transactionMapper.js";
import { getUserMappings, saveNewTransactions, type SaveResult } from "./transactionRepository.js";

/**
 * The one entry point for fetching a provider's transactions, shared by the
 * HTTP route, the local test script and (later) the scheduled sync job.
 *
 * The scrape runs in a local headless Chromium that talks straight to the
 * bank's own website; credentials go nowhere else and are not stored.
 */

export interface ScrapeRequest {
  /** israeli-bank-scrapers company id: "max", "isracard", "visaCal", "hapoalim", … */
  provider: CompanyTypes;
  /** The provider's login fields (see SCRAPERS[provider].loginFields). */
  credentials: Record<string, string>;
  startDate: Date;
  /** Inclusive. Scrapers always fetch up to today; later rows are dropped here. */
  endDate?: Date;
  headless?: boolean;
}

export interface ScrapeOutcome extends MapResult {
  accounts: { accountNumber: string; balance: number | null }[];
  /** Rows dated after `endDate`. */
  skippedOutOfRange: number;
}

export interface SyncOutcome extends ScrapeOutcome {
  expensesSaved: SaveResult;
  incomesSaved: SaveResult;
}

const israelYmd = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);

/** Logs in, scrapes and maps to the app's schema. Writes nothing. */
export async function scrapeProvider(
  request: ScrapeRequest,
  mappings: UserMappings = { expense: [], income: [] },
): Promise<ScrapeOutcome> {
  const { provider, credentials, startDate, endDate, headless } = request;

  const missing = missingLoginFields(provider, credentials);
  if (missing.length) throw new ApiError("MISSING_CREDENTIAL_FIELDS", { missing });
  if (startDate > new Date() || (endDate && endDate < startDate)) {
    throw new ApiError("INVALID_REQUEST", { fields: ["startDate", "endDate"] });
  }

  const accounts = await runScrape(provider, credentials, startDate, { headless });
  const mapped = mapScrapedTransactions(provider, accounts, mappings);

  let skippedOutOfRange = 0;
  if (endDate) {
    const last = israelYmd(endDate);
    const inRange = (rows: MapResult["expenses"]) =>
      rows.filter((tx) => (tx.date <= last ? true : (skippedOutOfRange++, false)));
    mapped.expenses = inRange(mapped.expenses);
    mapped.incomes = inRange(mapped.incomes);
  }

  return {
    ...mapped,
    skippedOutOfRange,
    accounts: accounts.map((a) => ({ accountNumber: a.accountNumber, balance: a.balance ?? null })),
  };
}

/**
 * Scrapes and saves new rows as drafts under users/{uid}. Rows already saved
 * (same id) or already present from a file upload (same date + amount +
 * business) are skipped.
 */
export async function syncProvider(uid: string, request: ScrapeRequest): Promise<SyncOutcome> {
  const outcome = await scrapeProvider(request, await getUserMappings(uid));
  try {
    const expensesSaved = await saveNewTransactions(uid, "transactions", outcome.expenses);
    const incomesSaved = await saveNewTransactions(uid, "incomeTransactions", outcome.incomes);
    return { ...outcome, expensesSaved, incomesSaved };
  } catch (err) {
    throw new ApiError("SAVE_FAILED", { internalMessage: err instanceof Error ? err.message : String(err) });
  }
}
