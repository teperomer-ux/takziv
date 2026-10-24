/**
 * Scheduled sync: syncs every healthy saved connection whose last sync is
 * over 24h old, at most MAX_CONCURRENT_SCRAPES at a time. Meant to run as a
 * Cloud Run Job (`node build/server/src/syncJob.js`) on a schedule; locally:
 *
 *   npm run sync:job
 *
 * Each connection goes through the same syncSavedConnection() as the API, so
 * leases, needs_attention handling and status updates behave identically. One
 * connection failing (wrong password, bank timeout, …) is logged and does not
 * fail the run; the exit code is non-zero only if the run itself broke.
 */
import { ApiError } from "./errors.js";
import { listActiveConnections } from "./connectionRepository.js";
import { needsBackfill, syncSavedConnection } from "./connectionSync.js";
import { MAX_CONCURRENT_SCRAPES, isSyncDue, syncResponseBody } from "./syncSupport.js";

type Outcome = "success" | "skipped" | "error";

function log(fields: Record<string, unknown>) {
  console.info(JSON.stringify({ event: "sync_job", ...fields }));
}

async function syncOne(uid: string, connectionId: string, companyId: string): Promise<Outcome> {
  const startedAt = Date.now();
  const ms = () => Date.now() - startedAt;
  try {
    const { outcome } = await syncSavedConnection(uid, connectionId);
    const body = syncResponseBody(outcome);
    log({ status: "success", uid, connectionId, companyId, ms: ms(), saved: body.savedCount, duplicates: body.duplicateCount });
    return "success";
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : new ApiError("INTERNAL_ERROR", { internalMessage: String(err) });
    const { internalMessage, ...details } = apiErr.details ?? {};
    // Another sync (the user's "sync now", another job run) holds the lease.
    const status = apiErr.code === "SCRAPE_IN_PROGRESS" ? "skipped" : "error";
    log({ status, uid, connectionId, companyId, ms: ms(), code: apiErr.code, ...details, internalMessage });
    return status;
  }
}

async function main() {
  const startedAt = Date.now();
  const now = new Date();
  const active = await listActiveConnections();
  // Due: stale, or the user moved its start date earlier and it hasn't been backfilled yet.
  const due = active.filter(({ connection }) => isSyncDue(connection.lastSyncAt, now) || needsBackfill(connection));
  log({ status: "start", active: active.length, due: due.length, concurrency: MAX_CONCURRENT_SCRAPES });

  const counts: Record<Outcome, number> = { success: 0, skipped: 0, error: 0 };
  let next = 0;
  // A fixed pool of workers pulling from a shared index keeps at most
  // MAX_CONCURRENT_SCRAPES browsers open, matching syncSavedConnection's slot cap.
  const worker = async () => {
    while (next < due.length) {
      const { uid, connection } = due[next++];
      counts[await syncOne(uid, connection.id, connection.companyId)]++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SCRAPES, due.length) }, worker));

  log({ status: "done", ...counts, ms: Date.now() - startedAt });
}

main().then(
  // firebase-admin keeps gRPC channels open, so exit explicitly.
  () => process.exit(0),
  (err) => {
    log({ status: "failed", error: String(err) });
    process.exit(1);
  },
);
