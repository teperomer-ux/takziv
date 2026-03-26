import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
} from "firebase/firestore";
import { db } from "../lib/firebase";

const COLLECTION = "pinnedBills";
const colRef = collection(db, COLLECTION);

export interface PinnedBill {
  description: string;
  avgAmount: number;
  typicalDay: number;
}

/** Fetch all pinned bills (one-shot). */
export async function getPinnedBills(): Promise<PinnedBill[]> {
  const snapshot = await getDocs(colRef);
  return snapshot.docs.map((d) => d.data() as PinnedBill);
}

/** Subscribe to pinned bills in real-time. */
export function onPinnedBillsSnapshot(
  callback: (bills: PinnedBill[]) => void,
  onError?: (err: Error) => void
): () => void {
  return onSnapshot(
    colRef,
    (snapshot) => {
      callback(snapshot.docs.map((d) => d.data() as PinnedBill));
    },
    onError
  );
}

/** Pin a business as a confirmed recurring bill. Uses description as doc ID. */
export async function pinBill(bill: PinnedBill): Promise<void> {
  await setDoc(doc(db, COLLECTION, bill.description), bill);
}

/** Unpin a recurring bill. */
export async function unpinBill(description: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTION, description));
}
