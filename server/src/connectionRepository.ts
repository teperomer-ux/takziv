import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { CompanyTypes } from "israeli-bank-scrapers";
import { adminDb } from "./firebaseAdmin.js";
import {
  decryptCredentials,
  encryptCredentials,
  kmsKeyWrapper,
  type CredentialEnvelope,
  type KeyWrapper,
} from "./credentialVault.js";

/**
 * Storage for saved bank connections, split in two:
 *
 *   bankSecrets/{connectionId}               encrypted credentials. Firestore
 *                                            rules deny every client read and
 *                                            write; only the Admin SDK reaches it.
 *   users/{uid}/bankConnections/{connectionId}  non-secret status the owner can
 *                                            read (never write) to render the UI.
 */

const SECRETS = "bankSecrets";

export type ConnectionStatus = "active" | "needs_attention" | "disabled";

export interface BankConnection {
  companyId: CompanyTypes;
  status: ConnectionStatus;
  /** API error code of the last failed sync, cleared on success. */
  lastErrorCode: string | null;
  lastSyncAt: FirebaseFirestore.Timestamp | null;
  createdAt: FirebaseFirestore.Timestamp;
}

interface SecretDoc {
  uid: string;
  companyId: CompanyTypes;
  envelope: CredentialEnvelope;
}

let defaultWrapper: KeyWrapper | undefined;
function wrapper() {
  const keyName = process.env.KMS_CREDENTIALS_KEY;
  if (!keyName) throw new Error("KMS_CREDENTIALS_KEY is not set");
  return (defaultWrapper ??= kmsKeyWrapper(keyName));
}

function connectionRef(uid: string, connectionId: string) {
  return adminDb.collection("users").doc(uid).collection("bankConnections").doc(connectionId);
}

/** Encrypts and stores new credentials; returns the new connection's id. */
export async function createConnection(
  uid: string,
  companyId: CompanyTypes,
  credentials: Record<string, string>,
): Promise<string> {
  const connectionId = randomUUID();
  const envelope = await encryptCredentials(wrapper(), uid, connectionId, credentials);

  const batch = adminDb.batch();
  batch.create(adminDb.collection(SECRETS).doc(connectionId), {
    uid,
    companyId,
    envelope,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.create(connectionRef(uid, connectionId), {
    companyId,
    status: "active",
    lastErrorCode: null,
    lastSyncAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return connectionId;
}

/** Replaces the stored credentials (e.g. after a password change) and re-activates the connection. */
export async function replaceCredentials(uid: string, connectionId: string, credentials: Record<string, string>) {
  await getOwnedSecret(uid, connectionId);
  const envelope = await encryptCredentials(wrapper(), uid, connectionId, credentials);

  const batch = adminDb.batch();
  batch.update(adminDb.collection(SECRETS).doc(connectionId), {
    envelope,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(connectionRef(uid, connectionId), { status: "active", lastErrorCode: null });
  await batch.commit();
}

/**
 * Decrypts a connection's credentials. Call only from the sync job: in
 * production only its service account can decrypt with the KMS key.
 */
export async function loadCredentials(uid: string, connectionId: string) {
  const secret = await getOwnedSecret(uid, connectionId);
  const credentials = await decryptCredentials(wrapper(), uid, connectionId, secret.envelope);
  return { companyId: secret.companyId, credentials };
}

export async function updateConnectionStatus(
  uid: string,
  connectionId: string,
  update: Partial<Pick<BankConnection, "status" | "lastErrorCode">> & { synced?: boolean },
) {
  const { synced, ...fields } = update;
  await connectionRef(uid, connectionId).update({
    ...fields,
    ...(synced && { lastSyncAt: FieldValue.serverTimestamp() }),
  });
}

/** Deletes the secret and its status doc together. */
export async function deleteConnection(uid: string, connectionId: string) {
  await getOwnedSecret(uid, connectionId);
  const batch = adminDb.batch();
  batch.delete(adminDb.collection(SECRETS).doc(connectionId));
  batch.delete(connectionRef(uid, connectionId));
  await batch.commit();
}

/** Every connection the daily job should sync. */
export async function listActiveConnections(): Promise<{ uid: string; connectionId: string }[]> {
  const snapshot = await adminDb.collectionGroup("bankConnections").where("status", "==", "active").get();
  return snapshot.docs.map((d) => ({ uid: d.ref.parent.parent!.id, connectionId: d.id }));
}

async function getOwnedSecret(uid: string, connectionId: string): Promise<SecretDoc> {
  const snap = await adminDb.collection(SECRETS).doc(connectionId).get();
  const data = snap.data() as SecretDoc | undefined;
  // Same answer for "missing" and "someone else's" so ids can't be probed.
  if (!data || data.uid !== uid) throw new ConnectionNotFoundError();
  return data;
}

export class ConnectionNotFoundError extends Error {
  constructor() {
    super("Connection not found");
  }
}
