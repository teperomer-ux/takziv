import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db, getUid, getUidOrNull } from "../lib/firebase";
import {
  DEFAULT_FINANCIAL_PROFILE,
  type UserFinancialProfile,
} from "../types/userProfile";

const DOC_ID = "financialProfile";
const NOOP = () => {};

function userRef() {
  return doc(db, "users", getUid(), "settings", DOC_ID);
}

export async function getFinancialProfile(): Promise<UserFinancialProfile> {
  if (!getUidOrNull()) return { ...DEFAULT_FINANCIAL_PROFILE };
  const snap = await getDoc(userRef());
  if (!snap.exists()) return { ...DEFAULT_FINANCIAL_PROFILE };
  return { ...DEFAULT_FINANCIAL_PROFILE, ...snap.data() } as UserFinancialProfile;
}

export async function saveFinancialProfile(
  profile: UserFinancialProfile,
): Promise<void> {
  await setDoc(userRef(), profile, { merge: true });
}

export function onFinancialProfileSnapshot(
  callback: (p: UserFinancialProfile) => void,
  onError?: (err: Error) => void,
): () => void {
  if (!getUidOrNull()) { callback({ ...DEFAULT_FINANCIAL_PROFILE }); return NOOP; }
  return onSnapshot(
    userRef(),
    (snap) => {
      if (snap.exists()) {
        callback({ ...DEFAULT_FINANCIAL_PROFILE, ...snap.data() } as UserFinancialProfile);
      } else {
        callback({ ...DEFAULT_FINANCIAL_PROFILE });
      }
    },
    onError,
  );
}
