import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
} from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Singleton — avoid double-init during Vite HMR
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Firestore with offline persistence for PWA support.
// persistentMultipleTabManager allows multiple browser tabs to share cache.
let db: ReturnType<typeof getFirestore>;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
} catch {
  // Already initialized (HMR reload) — grab the existing instance
  db = getFirestore(app);
}

const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

/**
 * Returns the currently authenticated user's UID.
 * Throws if no user is signed in — call this only from code paths
 * that are gated behind authentication (which the App component ensures).
 */
function getUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Not authenticated — getUid() called before onAuthStateChanged resolved");
  return uid;
}

/**
 * Non-throwing variant: returns the UID or null.
 * Use this in guards that should silently bail out (e.g. snapshot listeners
 * that may fire during the auth-loading window).
 */
function getUidOrNull(): string | null {
  return auth.currentUser?.uid ?? null;
}

export { app, db, auth, googleProvider, getUid, getUidOrNull };
