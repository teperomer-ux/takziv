import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
} from "firebase/firestore";
import { db, getUid, getUidOrNull } from "../lib/firebase";

const COLLECTION = "pinnedBills";
const NOOP = () => {};

function userCol() {
  return collection(db, "users", getUid(), COLLECTION);
}

function userDoc(docId: string) {
  return doc(db, "users", getUid(), COLLECTION, docId);
}

export interface PinnedBill {
  description: string;
  avgAmount: number;
  typicalDay: number;
}

/** Fetch all pinned bills (one-shot). */
export async function getPinnedBills(): Promise<PinnedBill[]> {
  if (!getUidOrNull()) return [];
  const snapshot = await getDocs(userCol());
  return snapshot.docs.map((d) => d.data() as PinnedBill);
}

/** Subscribe to pinned bills in real-time. */
export function onPinnedBillsSnapshot(
  callback: (bills: PinnedBill[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!getUidOrNull()) { callback([]); return NOOP; }
  return onSnapshot(
    userCol(),
    (snapshot) => {
      callback(snapshot.docs.map((d) => d.data() as PinnedBill));
    },
    onError
  );
}

/** Pin a business as a confirmed recurring bill. Uses description as doc ID. */
export async function pinBill(bill: PinnedBill): Promise<void> {
  await setDoc(userDoc(bill.description), bill);
}

/** Unpin a recurring bill. */
export async function unpinBill(description: string): Promise<void> {
  await deleteDoc(userDoc(description));
}
