import { Router } from "express";
import { z } from "zod";
import { CompanyTypes } from "israeli-bank-scrapers";
import { requireGoogleUser } from "./auth.js";
import { ApiError, sendError } from "./errors.js";
import { missingLoginFields } from "./scrapeRunner.js";
import { syncProvider } from "./scraperService.js";

const MAX_CONCURRENT_SCRAPES = Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2);

const bodySchema = z.object({
  companyId: z.enum(CompanyTypes),
  credentials: z.record(z.string().max(100), z.string().min(1).max(200)),
  startDate: z.iso.date(),
});

// Per-instance guards: one sync per user (repeated parallel logins can get a
// bank account locked) and a global cap on simultaneous Chromium instances.
const activeUsers = new Set<string>();

export const scrapeRouter = Router();

scrapeRouter.post("/api/scrape-transactions", requireGoogleUser, async (req, res) => {
  const uid: string = res.locals.uid;

  const parsed = bodySchema.safeParse(req.body);
  // Drop the only other reference to the raw credentials as early as possible.
  req.body = undefined;
  if (!parsed.success) {
    // Report which fields failed, never their values.
    return sendError(res, "INVALID_REQUEST", {
      fields: [...new Set(parsed.error.issues.map((i) => i.path[0]))],
    });
  }

  const { companyId, startDate } = parsed.data;
  let credentials: Record<string, string> | undefined = parsed.data.credentials;

  const missing = missingLoginFields(companyId, credentials);
  if (missing.length) return sendError(res, "MISSING_CREDENTIAL_FIELDS", { missing });

  const start = new Date(startDate);
  if (start > new Date()) return sendError(res, "INVALID_REQUEST", { fields: ["startDate"] });

  if (activeUsers.has(uid)) return sendError(res, "SCRAPE_IN_PROGRESS");
  if (activeUsers.size >= MAX_CONCURRENT_SCRAPES) return sendError(res, "SERVER_BUSY");
  activeUsers.add(uid);

  const startedAt = Date.now();
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ event: "scrape", uid, companyId, outcome, ms: Date.now() - startedAt, ...extra }));

  try {
    const request = { provider: companyId, credentials, startDate: start };
    credentials = undefined;
    const result = await syncProvider(uid, request);

    const fetched = result.expenses.length + result.incomes.length;
    const savedExpenses = result.expensesSaved.inserted;
    const savedIncomes = result.incomesSaved.inserted;
    const saved = savedExpenses + savedIncomes;
    const duplicateByContent = result.expensesSaved.duplicateByContent + result.incomesSaved.duplicateByContent;
    log("success", {
      fetched,
      saved,
      savedIncomes,
      duplicateByContent,
      skippedCardPayments: result.skippedCardPayments,
    });
    res.json({
      success: true,
      companyId,
      savedCount: saved,
      savedExpenseCount: savedExpenses,
      savedIncomeCount: savedIncomes,
      duplicateCount: fetched - saved,
      skippedPendingCount: result.skippedPending,
      skippedCardPaymentCount: result.skippedCardPayments,
      accounts: result.accounts,
    });
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : new ApiError("INTERNAL_ERROR");
    const { internalMessage, ...publicDetails } = apiErr.details ?? {};
    log("error", {
      code: apiErr.code,
      ...publicDetails,
      internalMessage: internalMessage ?? (err instanceof ApiError ? undefined : String(err)),
    });
    sendError(res, apiErr.code, Object.keys(publicDetails).length ? publicDetails : undefined);
  } finally {
    activeUsers.delete(uid);
  }
});
