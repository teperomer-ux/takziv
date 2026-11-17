import { doc, setDoc, onSnapshot } from "firebase/firestore";
import { db, getUid, getUidOrNull } from "../lib/firebase";
import { DEFAULT_BILLING_DAY, clampBillingDay, type DefaultMonthView } from "../utils/billingCycle";

const DOC_ID = "global";
const NOOP = () => {};

function userRef() {
  return doc(db, "users", getUid(), "settings", DOC_ID);
}

export interface AppSettings {
  theme: "light" | "dark";
  /** Sync saved bank connections in the background when the app opens (if last sync > 24h). */
  autoSyncOnStartup: boolean;
  /** Day of the month the credit cards are debited (1–28). */
  billingDay: number;
  /** A different billing day for one card company (max / isracard / cal). */
  billingDayBySource: Partial<Record<CardCompany, number>>;
  /** The month the app opens on: this month, or the last one that ended. */
  defaultMonthView: DefaultMonthView;
  /** Merchants (merchantKey) the user marked as a fixed charge. */
  fixedMerchants: string[];
  /** Merchants (merchantKey) the user marked as NOT a fixed charge. */
  notFixedMerchants: string[];
}

export type CardCompany = "max" | "isracard" | "cal";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  autoSyncOnStartup: false,
  billingDay: DEFAULT_BILLING_DAY,
  billingDayBySource: {},
  defaultMonthView: "current",
  fixedMerchants: [],
  notFixedMerchants: [],
};

/** A stored settings doc → settings the app can trust (older docs lack the newer fields). */
function normalizeSettings(data: Record<string, unknown>): AppSettings {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const bySource: AppSettings["billingDayBySource"] = {};
  if (data.billingDayBySource && typeof data.billingDayBySource === "object") {
    for (const company of ["max", "isracard", "cal"] as const) {
      const day = (data.billingDayBySource as Record<string, unknown>)[company];
      if (typeof day === "number") bySource[company] = clampBillingDay(day);
    }
  }
  return {
    theme: data.theme === "dark" ? "dark" : "light",
    autoSyncOnStartup: data.autoSyncOnStartup === true,
    billingDay: clampBillingDay(data.billingDay),
    billingDayBySource: bySource,
    defaultMonthView: data.defaultMonthView === "previous" ? "previous" : "current",
    fixedMerchants: strings(data.fixedMerchants),
    notFixedMerchants: strings(data.notFixedMerchants),
  };
}

export async function saveSettings(
  settings: Partial<AppSettings>
): Promise<void> {
  // mergeFields replaces each given field whole — a merge would keep the
  // removed keys of a map such as billingDayBySource.
  await setDoc(userRef(), settings, { mergeFields: Object.keys(settings) });
}

export function onSettingsSnapshot(
  callback: (s: AppSettings) => void,
  onError?: (err: Error) => void
): () => void {
  if (!getUidOrNull()) { callback({ ...DEFAULT_SETTINGS }); return NOOP; }
  return onSnapshot(
    userRef(),
    (snap) => {
      if (snap.exists()) {
        callback(normalizeSettings(snap.data()));
      } else {
        callback({ ...DEFAULT_SETTINGS });
      }
    },
    onError
  );
}
