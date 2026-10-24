import { Router } from "express";
import { z } from "zod";
import { CompanyTypes } from "israeli-bank-scrapers";
import { requireGoogleUser } from "./auth.js";
import { sendError } from "./errors.js";
import { missingLoginFields } from "./scrapeRunner.js";
import { syncProvider } from "./scraperService.js";
import { isValidStartDate, withProviderSlot } from "./connectionSync.js";
import { sendSyncError, syncLogger, syncResponseBody } from "./syncSupport.js";

const bodySchema = z.object({
  companyId: z.enum(CompanyTypes),
  credentials: z.record(z.string().max(100), z.string().min(1).max(200)),
  startDate: z.iso.date(),
});

export const scrapeRouter = Router();

/** One-off sync: credentials are used for this request only and not stored. */
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

  // Same range as saved connections: not in the future, at most a year back.
  if (!isValidStartDate(startDate)) return sendError(res, "INVALID_REQUEST", { fields: ["startDate"] });
  const start = new Date(startDate);

  const log = syncLogger({ uid, companyId });

  try {
    const request = { provider: companyId, credentials, startDate: start };
    credentials = undefined;
    const result = await withProviderSlot(uid, companyId, () => syncProvider(uid, request));
    const body = syncResponseBody(result);
    log("success", { saved: body.savedCount, duplicates: body.duplicateCount });
    res.json({ success: true, companyId, ...body });
  } catch (err) {
    sendSyncError(res, err, log);
  }
});
