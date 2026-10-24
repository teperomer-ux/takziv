import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  BankSyncError,
  connectAccount,
  listConnections,
  needsBackfill,
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
  notice: SyncNotice | null;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
  /** Background sync of a saved connection; resolves null on failure (the notice explains). */
  syncNow: (id: string) => Promise<ConnectionSyncResult | null>;
  connect: (companyId: string, credentials: Record<string, string>, startDate: string) => Promise<ConnectionSyncResult>;
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
  const autoSyncStarted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setConnections(await listConnections());
    } catch (err) {
      // Sync server not running / unreachable: keep the UI usable, just empty.
      console.warn("[useBankSync] could not list connections:", err);
    } finally {
      setConnectionsLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const replace = (c: BankConnection) =>
    setConnections((prev) => [...prev.filter((p) => p.id !== c.id), c]);

  const syncNow = useCallback(
    async (id: string) => {
      // One sync at a time: the server allows one per user anyway, and
      // parallel logins are what get bank accounts locked.
      if (syncingRef.current) return null;
      syncingRef.current = true;
      setSyncingId(id);
      const label = institutionLabel(connections.find((c) => c.id === id)?.companyId ?? "");
      try {
        const result = await syncConnection(id);
        replace(result.connection);
        setNotice({
          kind: "success",
          text:
            result.savedCount > 0
              ? `${label}: נוספו ${result.savedCount.toLocaleString("he-IL")} תנועות חדשות לאישור`
              : `${label}: אין תנועות חדשות`,
        });
        return result;
      } catch (err) {
        const code = err instanceof BankSyncError ? err.code : "INTERNAL_ERROR";
        await refresh(); // the server may have flipped the status
        const lastErrorCode = (err instanceof BankSyncError && (err.details?.lastErrorCode as string)) || code;
        const needsAction =
          code === "CONNECTION_NEEDS_ATTENTION" ||
          ["BANK_INVALID_CREDENTIALS", "BANK_OTP_REQUIRED", "BANK_CHANGE_PASSWORD", "BANK_ACCOUNT_BLOCKED"].includes(code);
        setNotice(
          needsAction
            ? { kind: "attention", text: `נדרשת התערבות — ${label}: ${attentionReason(lastErrorCode)}` }
            : {
                kind: "error",
                text: `${label}: ${err instanceof BankSyncError ? syncErrorMessage(code, err.details) : ERROR_MESSAGES[code]}`,
              },
        );
        return null;
      } finally {
        syncingRef.current = false;
        setSyncingId(null);
      }
    },
    [connections, refresh],
  );

  const connect = useCallback(async (companyId: string, credentials: Record<string, string>, startDate: string) => {
    const result = await connectAccount(companyId, credentials, startDate);
    replace(result.connection);
    return result;
  }, []);

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
    if (connections.some((c) => c.status === "needs_attention")) {
      const first = connections.find((c) => c.status === "needs_attention")!;
      setNotice({
        kind: "attention",
        text: `נדרשת התערבות — ${institutionLabel(first.companyId)}: ${attentionReason(first.lastErrorCode)}`,
      });
    }
  }, [settingsLoading, connectionsLoaded, settings.autoSyncOnStartup, connections, syncNow]);

  return {
    connections,
    connectionsLoaded,
    syncingId,
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
