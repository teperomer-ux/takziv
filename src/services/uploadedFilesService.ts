import { collection, doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
import { db } from "../lib/firebase";

const COLLECTION = "uploaded_files";
const colRef = collection(db, COLLECTION);

export interface UploadedFileRecord {
  hash: string;
  fileName: string;
  uploadedAt: Date;
}

/** Check whether a file with the given SHA-256 hash was already uploaded. */
export async function checkFileHash(
  hash: string
): Promise<UploadedFileRecord | null> {
  const snap = await getDoc(doc(colRef, hash));
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
  await setDoc(doc(colRef, hash), {
    fileName,
    uploadedAt: Timestamp.now(),
  });
}
