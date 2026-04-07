import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
import { db, getUid, getUidOrNull } from "../lib/firebase";

const COLLECTION = "uploaded_files";

function userDoc(docId: string) {
  return doc(db, "users", getUid(), COLLECTION, docId);
}

export interface UploadedFileRecord {
  hash: string;
  fileName: string;
  uploadedAt: Date;
}

/** Check whether a file with the given SHA-256 hash was already uploaded. */
export async function checkFileHash(
  hash: string
): Promise<UploadedFileRecord | null> {
  if (!getUidOrNull()) return null;
  const snap = await getDoc(userDoc(hash));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    hash,
    fileName: (data.fileName as string) ?? "",
    uploadedAt: (data.uploadedAt as Timestamp)?.toDate() ?? new Date(),
  };
}

/** Save a file fingerprint after a successful upload. */
export async function saveFileHash(
  hash: string,
  fileName: string
): Promise<void> {
  await setDoc(userDoc(hash), {
    fileName,
    uploadedAt: Timestamp.now(),
  });
}
