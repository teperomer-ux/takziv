import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";
import {
  DEFAULT_FINANCIAL_PROFILE,
  type UserFinancialProfile,
} from "../types/userProfile";

const ref = doc(db, "appSettings", "financialProfile");

export async function getFinancialProfile(): Promise<UserFinancialProfile> {
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ...DEFAULT_FINANCIAL_PROFILE };
  return { ...DEFAULT_FINANCIAL_PROFILE, ...snap.data() } as UserFinancialProfile;
}

export async function saveFinancialProfile(
  profile: UserFinancialProfile,
): Promise<void> {
  await setDoc(ref, profile, { merge: true });
}

export function onFinancialProfileSnapshot(
  callback: (p: UserFinancialProfile) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    ref,
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
