import { Router, type Response } from "express";
import { z } from "zod";
import { CompanyTypes } from "israeli-bank-scrapers";
import { requireGoogleUser } from "./auth.js";
import { ApiError, sendError } from "./errors.js";
import { missingLoginFields } from "./scrapeRunner.js";
import {
  ConnectionNotFoundError,
  assertVaultReady,
  deleteConnection,
  listConnections,
  updateConnectionStartDate,
  type BankConnection,
} from "./connectionRepository.js";
import { defaultStartYmd, isValidStartDate, saveUnverifiedConnection, syncSavedConnection } from "./connectionSync.js";
import { sendSyncError, syncLogger, syncResponseBody } from "./syncSupport.js";

/**
 * Saved bank connections. Credentials go in once (POST /api/connections),
 * are stored encrypted, and are never returned: every response carries only
 * provider, masked login, status and last-sync time.
 */
export const connectionsRouter = Router();
connectionsRouter.use("/api/connections", requireGoogleUser);

const createSchema = z.object({
  companyId: z.enum(CompanyTypes),
  credentials: z.record(z.string().max(100), z.string().min(1).max(200)),
  startDate: z.iso.date().optional(),
});
const idSchema = z.uuid();
const startDateSchema = z.object({ startDate: z.iso.date() });
const syncSchema = z.object({ startDate: z.iso.date().optional() });

/** Date fields fail validation as INVALID_REQUEST with `fields: ["startDate"]`, never echoing the value. */
function invalidStartDate(res: Response) {
  sendError(res, "INVALID_REQUEST", { fields: ["startDate"] });
}

function toJson(c: BankConnection) {
  return {
    ...c,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    sessionSavedAt: c.sessionSavedAt?.toISOString() ?? null,
  };
}

function parseId(id: unknown, res: Response) {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) sendError(res, "CONNECTION_NOT_FOUND");
  return parsed.success ? parsed.data : undefined;
}

connectionsRouter.get("/api/connections", async (_req, res) => {
  try {
    const connections = await listConnections(res.locals.uid);
    res.json({ success: true, connections: connections.map(toJson) });
  } catch (err) {
    console.error(JSON.stringify({ event: "list_connections_failed", error: String(err) }));
    sendError(res, "INTERNAL_ERROR");
  }
});

/**
 * Connects (or re-connects) a provider — the fast half only: validates,
 * encrypts and stores the credentials as status "syncing", and answers 201
 * with the connection right away, without logging in. The client then calls
 * POST /api/connections/:id/sync as a separate request, which logs in,
 * imports, and settles the status (active / needs_attention). See
 * saveUnverifiedConnection for why that isn't run here after responding.
 *
 * A wrong password is still never retried automatically: the scheduled job
 * only syncs active connections, and the first sync flags a rejected login.
 * Re-connecting keeps the existing connection (same id, transactions) and its
 * saved device state, which the next login reuses.
 */
connectionsRouter.post("/api/connections", async (req, res) => {
  const uid: string = res.locals.uid;
  const parsed = createSchema.safeParse(req.body);
  req.body = undefined;
  if (!parsed.success) {
    return sendError(res, "INVALID_REQUEST", { fields: [...new Set(parsed.error.issues.map((i) => i.path[0]))] });
  }

  const { companyId } = parsed.data;
  let credentials: Record<string, string> | undefined = parsed.data.credentials;
  const missing = missingLoginFields(companyId, credentials);
  if (missing.length) return sendError(res, "MISSING_CREDENTIAL_FIELDS", { missing });

  const startYmd = parsed.data.startDate ?? defaultStartYmd();
  if (!isValidStartDate(startYmd)) return invalidStartDate(res);

  try {
    assertVaultReady();
  } catch (err) {
    console.error(JSON.stringify({ event: "vault_unavailable", error: String(err) }));
    return sendError(res, "CREDENTIAL_STORE_UNAVAILABLE");
  }

  try {
    const connection = await saveUnverifiedConnection(uid, companyId, credentials, startYmd);
    credentials = undefined;
    console.info(JSON.stringify({ event: "connection_saved", uid, companyId, connectionId: connection.id }));
    res.status(201).json({ success: true, companyId, connectionId: connection.id, connection: toJson(connection) });
  } catch (err) {
    // SCRAPE_IN_PROGRESS: a sync of this provider's connection is running, and its
    // credentials can't be replaced mid-login. CONNECTION_NOT_FOUND: deleted meanwhile.
    if (err instanceof ApiError) return sendError(res, err.code);
    console.error(JSON.stringify({ event: "save_connection_failed", companyId, error: String(err) }));
    sendError(res, "CREDENTIAL_STORE_UNAVAILABLE");
  } finally {
    credentials = undefined;
  }
});

/**
 * Changes where a saved connection fetches from. Moving it earlier makes the
 * next sync backfill to the new date; moving it later only stops future syncs
 * from going back that far (already-imported rows stay).
 */
connectionsRouter.patch("/api/connections/:id", async (req, res) => {
  const id = parseId(req.params.id, res);
  if (!id) return;
  const parsed = startDateSchema.safeParse(req.body ?? {});
  if (!parsed.success || !isValidStartDate(parsed.data.startDate)) return invalidStartDate(res);

  try {
    const connection = await updateConnectionStartDate(res.locals.uid, id, parsed.data.startDate);
    res.json({ success: true, connection: toJson(connection) });
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) return sendError(res, "CONNECTION_NOT_FOUND");
    console.error(JSON.stringify({ event: "update_connection_failed", error: String(err) }));
    sendError(res, "INTERNAL_ERROR");
  }
});

/**
 * Syncs a saved connection with its stored credentials (see connectionSync.ts).
 * An optional `{ startDate }` body overrides the window for this sync only.
 */
connectionsRouter.post("/api/connections/:id/sync", async (req, res) => {
  const uid: string = res.locals.uid;
  const id = parseId(req.params.id, res);
  if (!id) return;
  const parsed = syncSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalidStartDate(res);

  const log = syncLogger({ uid, connectionId: id, via: "saved" });
  try {
    const { connection, outcome } = await syncSavedConnection(uid, id, { startDate: parsed.data.startDate });
    const body = syncResponseBody(outcome);
    log("success", { companyId: connection.companyId, saved: body.savedCount });
    res.json({ success: true, companyId: connection.companyId, connection: toJson(connection), ...body });
  } catch (err) {
    sendSyncError(res, err, log);
  }
});

connectionsRouter.delete("/api/connections/:id", async (req, res) => {
  const id = parseId(req.params.id, res);
  if (!id) return;
  try {
    await deleteConnection(res.locals.uid, id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) return sendError(res, "CONNECTION_NOT_FOUND");
    console.error(JSON.stringify({ event: "delete_connection_failed", error: String(err) }));
    sendError(res, "INTERNAL_ERROR");
  }
});
