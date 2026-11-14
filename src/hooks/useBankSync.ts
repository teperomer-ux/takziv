import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  BankSyncError,
  canRetryWithoutNewCredentials,
  connectAccount,
  listConnections,
  needsBackfill,
  onConnectionsSnapshot,
  removeConnection,
  syncConnection,
  updateConnectionStartDate,
  type BankConnection,
  type ConnectionSyncResult,
} from "../services/bankSyncService";
import type { AppSettings } from "../services/settingsService";
import { ERROR_MESSAGES, attentionReason, syncErrorMessage } from "../constants/bankSyncMessages";
import { institutionLabel } from "../constants/institutions";

const AUTO_SYNC_AFTER_MS = 24 * 60 * 60 * 1000;

type SyncAttempt = { ok: true; result: ConnectionSyncResult } | { ok: false; error: unknown };

export interface SyncNotice {
  kind: "success" | "attention" | "error";
  text: string;
}

interface BankSyncContextValue {
  connections: BankConnection[];
  /** True once the first connections fetch finished (successfully or not). */
  connectionsLoaded: boolean;
  /** Connection currently syncing in the background, if any. */
  syncingId: string | null;
  /** True while a sync of this connection runs or is queued: from this tab, or (per the server's lease) anywhere. */
  isSyncing: (c: BankConnection) => boolean;
  notice: SyncNotice | null;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
  /** Background sync of a saved connection; resolves null on failure (the notice explains). */
  syncNow: (id: string) => Promise<ConnectionSyncResult | null>;
  /**
   * Saves the connection and starts its first sync (a single bank login).
   * Resolves as soon as the bank accepts the login — the transactions are
   * then fetched in the background by that same session, and the outcome
   * arrives through the live connection list and a notice. Rejects with the
   * bank's error (BankSyncError) if the save fails or the login is refused.
   */
  connect: (companyId: string, credentials: Record<string, string>, startDate: string) => Promise<BankConnection>;
  disconnect: (id: string) => Promise<void>;
  /** Saves where future syncs of one connection fetch from (YYYY-MM-DD). Throws BankSyncError. */
  setStartDate: (id: string, startDate: string) => Promise<void>;
  /** Same date for every connection; resolves to how many updates failed. */
  setStartDateForAll: (startDate: string) => Promise<number>;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
}

export const BankSyncContext = createContext<BankSyncContextValue | null>(null);

/** Due for the startup auto-sync: over 24h since the last sync, or a backfill is pending. */
function isStale(c: BankConnection) {
  return !c.lastSyncAt || Date.now() - new Date(c.lastSyncAt).getTime() > AUTO_SYNC_AFTER_MS || needsBackfill(c);
}

/**
 * Owns saved-connection state for the whole app so the header can show a
 * background-sync spinner and "needs attention" prompts no matter which
 * screen started the sync. Mount once, in the authenticated shell.
 */
export function useBankSyncProvider(settings: AppSettings, settingsLoading: boolean): BankSyncContextValue {
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<SyncNotice | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  /** Connected in this tab, first sync queued or running. */
  const [backgroundIds, setBackgroundIds] = useState<string[]>([]);
  const syncingRef = useRef(false);
  const currentSync = useRef<Promise<unknown> | null>(null);
  const autoSyncStarted = useRef(false);
  /** True once the Firestore listener has delivered: from then on it is the source of truth. */
  const liveRef = useRef(false);
  /**
   * connect() calls waiting for the bank to accept a just-saved login.
   * `sawUnverified`: a snapshot after the save (loginVerified false) has been
   * seen, so a later true is this login's — not a stale pre-save snapshot.
   */
  const loginWaiters = useRef(new Map<string, { sawUnverified: boolean; resolve: () => void }>());
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const refresh = useCallback(async () => {
    if (liveRef.current) return; // the listener already keeps the list current
    try {
      const list = await listConnections();
      if (!liveRef.current) setConnections(list);
    } catch (err) {
      // Sync server not running / unreachable: keep the UI usable, just empty.
      console.warn("[useBankSync] could not list connections:", err);
    } finally {
      setConnectionsLoaded(true);
    }
  }, []);

  // Live list, so a background sync's outcome (active / needs_attention)
  // reaches every screen by itself. The API fetch covers the first moments,
  // and stays the source if the listener fails.
  useEffect(() => {
    refresh();
    const unsubscribe = onConnectionsSnapshot(
      (list) => {
        liveRef.current = true;
        setConnections(list);
        setConnectionsLoaded(true);
        for (const c of list) {
          const waiter = loginWaiters.current.get(c.id);
          if (!waiter) continue;
          if (!c.loginVerified) waiter.sawUnverified = true;
          else if (waiter.sawUnverified) waiter.resolve();
        }
      },
      (err) => {
        console.warn("[useBankSync] live connection updates unavailable:", err);
        liveRef.current = false;
        refresh();
      },
    );
    return () => {
      liveRef.current = false;
      unsubscribe();
    };
  }, [refresh]);

  const replace = (c: BankConnection) =>
    setConnections((prev) => [...prev.filter((p) => p.id !== c.id), c]);

  /**
   * Runs one sync of a saved connection and reports it in a notice. Resolves
   * null if another sync is already running (one bank login at a time: the
   * server allows one per user anyway, and parallel logins are what get bank
   * accounts locked), otherwise the outcome.
   *
   * `loginConfirmed` is passed only by connect(): until it returns true the
   * connect dialog is still open and shows a failure itself, so no notice.
   */
  const startSync = useCallback(
    (
      id: string,
      { companyId, loginConfirmed }: { companyId?: string; loginConfirmed?: () => boolean } = {},
    ): Promise<SyncAttempt> | null => {
      if (syncingRef.current) return null;
      syncingRef.current = true;
      setSyncingId(id);
      const label = institutionLabel(companyId ?? connectionsRef.current.find((c) => c.id === id)?.companyId ?? "");
      const first = loginConfirmed !== undefined;
      const run = (async (): Promise<SyncAttempt> => {
        try {
          const result = await syncConnection(id);
          replace(result.connection);
          const added =
            result.savedCount > 0
              ? `נוספו ${result.savedCount.toLocaleString("he-IL")} תנועות חדשות לאישור`
              : "אין תנועות חדשות";
          setNotice({ kind: "success", text: first ? `${label} חובר בהצלחה — ${added}` : `${label}: ${added}` });
          return { ok: true, result };
        } catch (err) {
          const code = err instanceof BankSyncError ? err.code : "INTERNAL_ERROR";
          await refresh(); // the server may have flipped the status (a no-op while the live list is on)
          if (first && !loginConfirmed()) return { ok: false, error: err };
          const lastErrorCode = (err instanceof BankSyncError && (err.details?.lastErrorCode as string)) || code;
          const needsAction =
            code === "CONNECTION_NEEDS_ATTENTION" ||
            ["BANK_INVALID_CREDENTIALS", "BANK_OTP_REQUIRED", "BANK_CHANGE_PASSWORD", "BANK_ACCOUNT_BLOCKED"].includes(code);
          const heading = lastErrorCode === "BANK_OTP_REQUIRED" ? "פג תוקף האימות" : "נדרשת התערבות";
          const reason = err instanceof BankSyncError ? syncErrorMessage(code, err.details) : ERROR_MESSAGES[code];
          setNotice(
            needsAction
              ? { kind: "attention", text: `${heading} — ${label}: ${attentionReason(lastErrorCode)}` }
              : {
                  kind: "error",
                  text: first ? `${label}: ההתחברות הצליחה, אך משיכת הנתונים נכשלה. ${reason}` : `${label}: ${reason}`,
                },
          );
          return { ok: false, error: err };
        } finally {
          syncingRef.current = false;
          currentSync.current = null;
          setSyncingId(null);
        }
      })();
      currentSync.current = run;
      return run;
    },
    [refresh],
  );

  const syncNow = useCallback(
    async (id: string) => {
      const attempt = await startSync(id);
      return attempt?.ok ? attempt.result : null;
    },
    [startSync],
  );

  const connect = useCallback(
    async (companyId: string, credentials: Record<string, string>, startDate: string) => {
      // Stage 0 (fast): store the credentials, unverified.
      const { connectionId, connection } = await connectAccount(companyId, credentials, startDate);
      replace(connection);
      setBackgroundIds((ids) => [...ids, connectionId]);

      // Stage 1: one sync request = one bank login. It stays open until the
      // whole scrape ends (Cloud Run only guarantees CPU while a request is in
      // flight), but the server flags loginVerified the moment the bank
      // accepts the login, and the live list hands that to the waiter below.
      let confirmed = false;
      const loginSeen = new Promise<"login">((resolve) =>
        loginWaiters.current.set(connectionId, { sawUnverified: false, resolve: () => resolve("login") }),
      );
      const sync = (async () => {
        try {
          // Wait out a sync that's already running (startup auto-sync, "sync now").
          while (syncingRef.current) await currentSync.current;
          return await startSync(connectionId, { companyId, loginConfirmed: () => confirmed });
        } finally {
          loginWaiters.current.delete(connectionId);
          setBackgroundIds((ids) => ids.filter((i) => i !== connectionId));
        }
      })();

      const first = await Promise.race([loginSeen, sync]);
      if (first === null) throw new BankSyncError("SCRAPE_IN_PROGRESS", "Another sync is running");
      if (first !== "login" && !first.ok) throw first.error; // rejected before the login was confirmed
      confirmed = true;
      // Stage 2 runs on in the background (same request, same browser); its
      // outcome replaces this notice when it ends.
      if (first === "login") {
        setNotice({ kind: "success", text: `${institutionLabel(companyId)}: התחברת בהצלחה! מושך נתונים ברקע...` });
      }
      return connection;
    },
    [startSync],
  );

  const isSyncing = useCallback(
    (c: BankConnection) => syncingId === c.id || backgroundIds.includes(c.id) || c.syncInProgress,
    [syncingId, backgroundIds],
  );

  const disconnect = useCallback(async (id: string) => {
    await removeConnection(id);
    setConnections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const setStartDate = useCallback(async (id: string, startDate: string) => {
    replace(await updateConnectionStartDate(id, startDate));
  }, []);

  const setStartDateForAll = useCallback(
    async (startDate: string) => {
      const results = await Promise.allSettled(connections.map((c) => updateConnectionStartDate(c.id, startDate)));
      for (const r of results) if (r.status === "fulfilled") replace(r.value);
      return results.filter((r) => r.status === "rejected").length;
    },
    [connections],
  );

  // ── Auto-sync on startup ──────────────────────────────────────────
  // Once per app load, after settings and connections are known: sync every
  // healthy connection whose last sync is over 24h old, one after another.
  // Connections needing attention are skipped (the server refuses them too).
  useEffect(() => {
    if (settingsLoading || !connectionsLoaded || autoSyncStarted.current) return;
    if (!settings.autoSyncOnStartup) return;
    autoSyncStarted.current = true;

    const due = connections.filter((c) => c.status === "active" && isStale(c));
    (async () => {
      for (const c of due) await syncNow(c.id);
    })();
    const flagged = connections.find((c) => c.status === "needs_attention");
    // Connected earlier, but the first sync never finished (tab closed, timeout).
    // Not synced automatically: its login hasn't been confirmed yet.
    const unverified = connections.find((c) => c.status === "syncing" && !c.syncInProgress);
    if (flagged) {
      const heading = canRetryWithoutNewCredentials(flagged) ? "פג תוקף האימות" : "נדרשת התערבות";
      setNotice({
        kind: "attention",
        text: `${heading} — ${institutionLabel(flagged.companyId)}: ${attentionReason(flagged.lastErrorCode)}`,
      });
    } else if (unverified) {
      setNotice({
        kind: "attention",
        text: `החיבור ל${institutionLabel(unverified.companyId)} טרם הושלם — פתחו את החשבונות המחוברים ולחצו "סנכרן עכשיו".`,
      });
    }
  }, [settingsLoading, connectionsLoaded, settings.autoSyncOnStartup, connections, syncNow]);

  return {
    connections,
    connectionsLoaded,
    syncingId,
    isSyncing,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    refresh,
    syncNow,
    connect,
    disconnect,
    setStartDate,
    setStartDateForAll,
    modalOpen,
    openModal: useCallback(() => setModalOpen(true), []),
    closeModal: useCallback(() => setModalOpen(false), []),
  };
}

export function useBankSync(): BankSyncContextValue {
  const ctx = useContext(BankSyncContext);
  if (!ctx) throw new Error("useBankSync must be used inside BankSyncContext");
  return ctx;
}
