import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
// Uses Application Default Credentials: the service account on Cloud Run, or
// GOOGLE_APPLICATION_CREDENTIALS / `gcloud auth application-default login` locally.
const app = getApps()[0] ??
    initializeApp({
        credential: applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
    });
export const adminAuth = getAuth(app);
export const adminDb = getFirestore(app);
