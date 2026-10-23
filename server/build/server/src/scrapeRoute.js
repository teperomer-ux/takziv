import { Router } from "express";
import { z } from "zod";
import { CompanyTypes } from "israeli-bank-scrapers";
import { requireGoogleUser } from "./auth.js";
import { ApiError, sendError } from "./errors.js";
import { missingLoginFields, runScrape } from "./scrapeRunner.js";
import { mapScrapedTransactions } from "./transactionMapper.js";
import { getUserMappings, saveNewTransactions } from "./transactionRepository.js";
const MAX_CONCURRENT_SCRAPES = Number(process.env.MAX_CONCURRENT_SCRAPES ?? 2);
const bodySchema = z.object({
    companyId: z.enum(CompanyTypes),
    credentials: z.record(z.string().max(100), z.string().min(1).max(200)),
    startDate: z.iso.date(),
});
// Per-instance guards: one sync per user (repeated parallel logins can get a
// bank account locked) and a global cap on simultaneous Chromium instances.
const activeUsers = new Set();
export const scrapeRouter = Router();
scrapeRouter.post("/api/scrape-transactions", requireGoogleUser, async (req, res) => {
    const uid = res.locals.uid;
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
    let credentials = parsed.data.credentials;
    const missing = missingLoginFields(companyId, credentials);
    if (missing.length)
        return sendError(res, "MISSING_CREDENTIAL_FIELDS", { missing });
    const start = new Date(startDate);
    if (start > new Date())
        return sendError(res, "INVALID_REQUEST", { fields: ["startDate"] });
    if (activeUsers.has(uid))
        return sendError(res, "SCRAPE_IN_PROGRESS");
    if (activeUsers.size >= MAX_CONCURRENT_SCRAPES)
        return sendError(res, "SERVER_BUSY");
    activeUsers.add(uid);
    const startedAt = Date.now();
    const log = (outcome, extra = {}) => console.info(JSON.stringify({ event: "scrape", uid, companyId, outcome, ms: Date.now() - startedAt, ...extra }));
    try {
        let accounts;
        try {
            accounts = await runScrape(companyId, credentials, start);
        }
        finally {
            credentials = undefined;
        }
        const mappings = await getUserMappings(uid);
        const { expenses, incomes, skippedPending, skippedCardPayments } = mapScrapedTransactions(companyId, accounts, mappings);
        let savedExpenses;
        let savedIncomes;
        try {
            savedExpenses = await saveNewTransactions(uid, "transactions", expenses);
            savedIncomes = await saveNewTransactions(uid, "incomeTransactions", incomes);
        }
        catch (err) {
            throw new ApiError("SAVE_FAILED", { internalMessage: err instanceof Error ? err.message : String(err) });
        }
        const fetched = expenses.length + incomes.length;
        const saved = savedExpenses + savedIncomes;
        log("success", { fetched, saved, savedIncomes, skippedCardPayments });
        res.json({
            success: true,
            companyId,
            savedCount: saved,
            savedExpenseCount: savedExpenses,
            savedIncomeCount: savedIncomes,
            duplicateCount: fetched - saved,
            skippedPendingCount: skippedPending,
            skippedCardPaymentCount: skippedCardPayments,
            accounts: accounts.map((a) => ({ accountNumber: a.accountNumber, balance: a.balance ?? null })),
        });
    }
    catch (err) {
        const apiErr = err instanceof ApiError ? err : new ApiError("INTERNAL_ERROR");
        // Details (scraper error type, login stage, redacted message) are server
        // diagnostics: logged here, never sent to the client.
        const { internalMessage, ...diagnostics } = apiErr.details ?? {};
        log("error", {
            code: apiErr.code,
            ...diagnostics,
            internalMessage: internalMessage ?? (err instanceof ApiError ? undefined : String(err)),
        });
        sendError(res, apiErr.code);
    }
    finally {
        activeUsers.delete(uid);
    }
});
