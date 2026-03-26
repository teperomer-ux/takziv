import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
} from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCVr7JMq4pXhgiDS9hO6ITamlkNOYdkLCQ",
  authDomain: "takziv-25fd8.firebaseapp.com",
  projectId: "takziv-25fd8",
  storageBucket: "takziv-25fd8.firebasestorage.app",
  messagingSenderId: "770357840222",
  appId: "1:770357840222:web:9f652152d9f319b6b9e7cf",
  measurementId: "G-LV51C6TNDV",
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

export { app, db, auth, googleProvider };
