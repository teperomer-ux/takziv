import { Router, type Response } from "express";
import { z } from "zod";
import { CompanyTypes } from "israeli-bank-scrapers";
import { requireGoogleUser } from "./auth.js";
import { ApiError, sendError } from "./errors.js";
import { missingLoginFields } from "./scrapeRunner.js";
import { syncProvider } from "./scraperService.js";
import {
  ConnectionNotFoundError,
  assertVaultReady,
  deleteConnection,
  getConnection,
  listConnections,
  loadCredentials,
  saveConnection,
  updateConnectionStatus,
  type BankConnection,
} from "./connectionRepository.js";
import { REQUIRES_ACTION, acquireSyncSlot, sendSyncError, syncLogger, syncResponseBody } from "./syncSupport.js";

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

/** Overlap re-fetched on every sync so pending rows that settled since are picked up. */
const OVERLAP_DAYS = 7;
const MAX_LOOKBACK_DAYS = 365;

function toJson(c: BankConnection) {
  return { ...c, lastSyncAt: c.lastSyncAt?.toISOString() ?? null };
}

/** From the 1st of last month, the same default the sync form uses. */
function defaultStartDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

function syncStartDate(lastSyncAt: Date | null) {
  if (!lastSyncAt) return defaultStartDate();
  const from = new Date(lastSyncAt.getTime() - OVERLAP_DAYS * 86_400_000);
  const floor = new Date(Date.now() - MAX_LOOKBACK_DAYS * 86_400_000);
  return from < floor ? floor : from;
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

  const release = acquireSyncSlot(uid);
  if (typeof release === "string") return sendError(res, release);
  const log = syncLogger({ uid, companyId, via: "connect" });

  try {
    const result = await syncProvider(uid, { provider: companyId, credentials, startDate });
    const connection = await saveConnection(uid, companyId, credentials, { synced: true });
    credentials = undefined;
    const body = syncResponseBody(result);
    log("success", { saved: body.savedCount, connectionId: connection.id });
    res.json({ success: true, companyId, connection: toJson(connection), ...body });
  } catch (err) {
    sendSyncError(res, err, log);
  } finally {
    credentials = undefined;
    release();
  }
});

/** Syncs a saved connection with its stored credentials. */
connectionsRouter.post("/api/connections/:id/sync", async (req, res) => {
  const uid: string = res.locals.uid;
  const id = parseId(req.params.id, res);
  if (!id) return;

  let connection: BankConnection;
  try {
    connection = await getConnection(uid, id);
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) return sendError(res, "CONNECTION_NOT_FOUND");
    throw err;
  }
  // Never retry a login the bank already rejected — that's how accounts get locked.
  if (connection.status === "needs_attention") {
    return sendError(res, "CONNECTION_NEEDS_ATTENTION", { lastErrorCode: connection.lastErrorCode });
  }

  const release = acquireSyncSlot(uid);
  if (typeof release === "string") return sendError(res, release);
  const log = syncLogger({ uid, companyId: connection.companyId, connectionId: id, via: "saved" });

  try {
    let stored;
    try {
      stored = await loadCredentials(uid, id);
    } catch (err) {
      // Key missing/changed: the saved login is unusable until re-entered.
      await updateConnectionStatus(uid, id, { status: "needs_attention", lastErrorCode: "CREDENTIALS_UNREADABLE" });
      throw new ApiError("CONNECTION_NEEDS_ATTENTION", {
        lastErrorCode: "CREDENTIALS_UNREADABLE",
        internalMessage: String(err),
      });
    }

    const result = await syncProvider(uid, {
      provider: stored.companyId,
      credentials: stored.credentials,
      startDate: syncStartDate(connection.lastSyncAt),
    });
    await updateConnectionStatus(uid, id, { status: "active", lastErrorCode: null, synced: true });
    const body = syncResponseBody(result);
    log("success", { saved: body.savedCount });
    res.json({ success: true, companyId: stored.companyId, connection: toJson(await getConnection(uid, id)), ...body });
  } catch (err) {
    const code = sendSyncError(res, err, log);
    if (code !== "CONNECTION_NEEDS_ATTENTION") {
      await updateConnectionStatus(uid, id, {
        ...(REQUIRES_ACTION.has(code) && { status: "needs_attention" }),
        lastErrorCode: code,
      }).catch((e) => console.error(JSON.stringify({ event: "status_update_failed", error: String(e) })));
    }
  } finally {
    release();
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
