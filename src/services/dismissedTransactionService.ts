import { doc, serverTimestamp, writeBatch } from "firebase/firestore";
import { db, getUid } from "../lib/firebase";

/**
 * Deletes a transaction and remembers its id in users/{uid}/dismissedTransactions,
 * in one atomic batch. Bank-synced rows have deterministic ids, so without the
 * tombstone the next sync would see the id missing and import the row again.
 */
export async function deleteAndDismiss(collectionName: "transactions" | "incomeTransactions", id: string) {
  const uid = getUid();
  const batch = writeBatch(db);
  batch.delete(doc(db, "users", uid, collectionName, id));
  batch.set(doc(db, "users", uid, "dismissedTransactions", id), {
    collection: collectionName,
    dismissedAt: serverTimestamp(),
  });
  await batch.commit();
}
