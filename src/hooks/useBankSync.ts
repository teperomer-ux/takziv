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

function addedText(r: ConnectionSyncResult) {
  return r.savedCount > 0 ? `נוספו ${r.savedCount.toLocaleString("he-IL")} תנועות חדשות לאישור` : "אין תנועות חדשות";
}

function errorReason(err: unknown) {
  return err instanceof BankSyncError ? syncErrorMessage(err.code, err.details) : ERROR_MESSAGES.INTERNAL_ERROR;
}

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
   * Connects a provider (a single bank login). Resolves with the connection
   * as soon as the bank accepts the login — nothing exists before that — and
   * the same session then fetches the transactions in the background; the
   * outcome arrives through the live list and a notice. Rejects with the
   * error (BankSyncError) if the login fails; no connection is created.
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
  const syncingRef = useRef(false);
  const currentSync = useRef<Promise<unknown> | null>(null);
  const autoSyncStarted = useRef(false);
  /** True once the Firestore listener has delivered: from then on it is the source of truth. */
  const liveRef = useRef(false);
  /**
   * connect() calls waiting for the bank to accept their login, by attemptId.
   * The server writes the connection — tagged with that id — only once the
   * login got through, so the first snapshot carrying it is the signal.
   */
  const attemptWaiters = useRef(new Map<string, (connection: BankConnection) => void>());
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
          const waiter = c.connectAttemptId ? attemptWaiters.current.get(c.connectAttemptId) : undefined;
          waiter?.(c);
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
   * Runs `run` in the one-login-at-a-time slot, waiting for it if a sync is
   * already running: the server allows one per user anyway, and parallel
   * logins are what get bank accounts locked.
   */
  const exclusive = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    while (syncingRef.current) await currentSync.current;
    syncingRef.current = true;
    const p = (async () => {
      try {
        return await run();
      } finally {
        syncingRef.current = false;
        currentSync.current = null;
        setSyncingId(null);
      }
    })();
    currentSync.current = p;
    return p;
  }, []);

  const syncNow = useCallback(
    async (id: string): Promise<ConnectionSyncResult | null> => {
      // A tap while another sync runs is ignored rather than queued.
      if (syncingRef.current) return null;
      const label = institutionLabel(connectionsRef.current.find((c) => c.id === id)?.companyId ?? "");
      return exclusive(async () => {
        setSyncingId(id);
        try {
          const result = await syncConnection(id);
          replace(result.connection);
          setNotice({ kind: "success", text: `${label}: ${addedText(result)}` });
          return result;
        } catch (err) {
          const code = err instanceof BankSyncError ? err.code : "INTERNAL_ERROR";
          await refresh(); // the server may have flipped the status (a no-op while the live list is on)
          const lastErrorCode = (err instanceof BankSyncError && (err.details?.lastErrorCode as string)) || code;
          const needsAction =
            code === "CONNECTION_NEEDS_ATTENTION" ||
            ["BANK_INVALID_CREDENTIALS", "BANK_OTP_REQUIRED", "BANK_CHANGE_PASSWORD", "BANK_ACCOUNT_BLOCKED"].includes(code);
          const heading = lastErrorCode === "BANK_OTP_REQUIRED" ? "פג תוקף האימות" : "נדרשת התערבות";
          setNotice(
            needsAction
              ? { kind: "attention", text: `${heading} — ${label}: ${attentionReason(lastErrorCode)}` }
              : { kind: "error", text: `${label}: ${errorReason(err)}` },
          );
          return null;
        }
      });
    },
    [exclusive, refresh],
  );

  const connect = useCallback(
    async (companyId: string, credentials: Record<string, string>, startDate: string) => {
      const label = institutionLabel(companyId);
      const attemptId = crypto.randomUUID();
      let loginConfirmed = false;
      const loginSeen = new Promise<{ login: BankConnection }>((resolve) =>
        attemptWaiters.current.set(attemptId, (c) => {
          loginConfirmed = true;
          setSyncingId(c.id); // header + card show the background fetch
          resolve({ login: c });
        }),
      );

      // One request = one bank login, kept open for the whole scrape (Cloud
      // Run only guarantees CPU while a request is in flight).
      const request = exclusive(async (): Promise<SyncAttempt> => {
        try {
          const result = await connectAccount(companyId, credentials, startDate, attemptId);
          replace(result.connection);
          setNotice({ kind: "success", text: `${label} חובר בהצלחה — ${addedText(result)}` });
          return { ok: true, result };
        } catch (err) {
          // Before the login was confirmed the dialog is still open and shows
          // the error itself; nothing was saved. After it, the account exists
          // and only its first fetch failed.
          if (loginConfirmed) {
            setNotice({ kind: "error", text: `${label}: הסנכרון הראשון לא הושלם. ${errorReason(err)}` });
          }
          return { ok: false, error: err };
        } finally {
          attemptWaiters.current.delete(attemptId);
        }
      });

      const first = await Promise.race([loginSeen, request]);
      if ("login" in first) return first.login;
      if (!first.ok) throw first.error;
      return first.result.connection;
    },
    [exclusive],
  );

  const isSyncing = useCallback(
    (c: BankConnection) => syncingId === c.id || c.syncInProgress,
    [syncingId],
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
    // Connected (login verified) but the first fetch never finished.
    const incomplete = connections.find((c) => c.status === "syncing" && !c.syncInProgress);
    if (flagged) {
      const heading = canRetryWithoutNewCredentials(flagged) ? "פג תוקף האימות" : "נדרשת התערבות";
      setNotice({
        kind: "attention",
        text: `${heading} — ${institutionLabel(flagged.companyId)}: ${attentionReason(flagged.lastErrorCode)}`,
      });
    } else if (incomplete) {
      setNotice({
        kind: "attention",
        text: `${institutionLabel(incomplete.companyId)}: הסנכרון הראשון לא הושלם — פתחו את החשבונות המחוברים ולחצו "סנכרן עכשיו".`,
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
