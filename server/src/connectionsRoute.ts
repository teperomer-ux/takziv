import { Router, type Response } from "express";
import { z } from "zod";
import { CompanyTypes } from "israeli-bank-scrapers";
import { requireGoogleUser } from "./auth.js";
import { sendError } from "./errors.js";
import { missingLoginFields } from "./scrapeRunner.js";
import { syncProvider } from "./scraperService.js";
import {
  ConnectionNotFoundError,
  assertVaultReady,
  deleteConnection,
  listConnections,
  saveConnection,
  type BankConnection,
} from "./connectionRepository.js";
import { defaultStartDate, syncSavedConnection, withProviderSlot } from "./connectionSync.js";
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

function toJson(c: BankConnection) {
  return { ...c, lastSyncAt: c.lastSyncAt?.toISOString() ?? null };
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
 * Connects (or re-connects) a provider: logs in and imports once, and stores
 * the credentials only if that login worked — a wrong password is never saved
 * and so never retried automatically.
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

  const startDate = parsed.data.startDate ? new Date(parsed.data.startDate) : defaultStartDate();
  if (startDate > new Date()) return sendError(res, "INVALID_REQUEST", { fields: ["startDate"] });

  try {
    assertVaultReady();
  } catch (err) {
    console.error(JSON.stringify({ event: "vault_unavailable", error: String(err) }));
    return sendError(res, "CREDENTIAL_STORE_UNAVAILABLE");
  }

  const log = syncLogger({ uid, companyId, via: "connect" });
  try {
    const { result, connection } = await withProviderSlot(uid, companyId, async () => {
      const result = await syncProvider(uid, { provider: companyId, credentials: credentials!, startDate });
      return { result, connection: await saveConnection(uid, companyId, credentials!, { synced: true }) };
    });
    credentials = undefined;
    const body = syncResponseBody(result);
    log("success", { saved: body.savedCount, connectionId: connection.id });
    res.json({ success: true, companyId, connection: toJson(connection), ...body });
  } catch (err) {
    sendSyncError(res, err, log);
  } finally {
    credentials = undefined;
  }
});

/** Syncs a saved connection with its stored credentials (see connectionSync.ts). */
connectionsRouter.post("/api/connections/:id/sync", async (req, res) => {
  const uid: string = res.locals.uid;
  const id = parseId(req.params.id, res);
  if (!id) return;

  const log = syncLogger({ uid, connectionId: id, via: "saved" });
  try {
    const { connection, outcome } = await syncSavedConnection(uid, id);
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
