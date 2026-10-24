import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { SCRAPERS, type CompanyTypes } from "israeli-bank-scrapers";
import { adminDb } from "./firebaseAdmin.js";
import {
  CredentialVaultError,
  decryptCredentials,
  encryptCredentials,
  kmsKeyWrapper,
  localKeyWrapper,
  type CredentialEnvelope,
  type KeyWrapper,
} from "./credentialVault.js";
import { loadOrCreateLocalKey } from "./localKey.js";

/**
 * Storage for saved bank connections, split in two:
 *
 *   bankSecrets/{connectionId}                  encrypted credentials. Firestore
 *                                               rules deny every client read and
 *                                               write; only the Admin SDK reaches it.
 *   users/{uid}/bankConnections/{connectionId}  non-secret status (provider,
 *                                               masked login, last sync) that the
 *                                               API returns to the owner, plus
 *                                               the sync lease (syncLockUntil,
 *                                               syncLeaseToken).
 *
 * Credentials are wrapped with Cloud KMS when KMS_CREDENTIALS_KEY is set, and
 * otherwise with a local key file (server/.secrets/credentials.key).
 */

const SECRETS = "bankSecrets";

export type ConnectionStatus = "active" | "needs_attention";
type KeySource = "kms" | "local";

export interface BankConnection {
  id: string;
  companyId: CompanyTypes;
  status: ConnectionStatus;
  /** e.g. "•••789" — the last characters of the login identifier, never a secret field. */
  maskedLogin: string;
  /** API error code of the last failed sync, cleared on success. */
  lastErrorCode: string | null;
  lastSyncAt: Date | null;
}

interface SecretDoc {
  uid: string;
  companyId: CompanyTypes;
  keySource: KeySource;
  envelope: CredentialEnvelope;
}

let vault: { source: KeySource; wrapper: KeyWrapper } | undefined;
function getVault() {
  if (!vault) {
    const keyName = process.env.KMS_CREDENTIALS_KEY;
    vault = keyName
      ? { source: "kms", wrapper: kmsKeyWrapper(keyName) }
      : { source: "local", wrapper: localKeyWrapper(loadOrCreateLocalKey()) };
  }
  return vault;
}

/** Fails fast (before a bank login) if credentials couldn't be stored. */
export function assertVaultReady() {
  getVault();
}

const SECRET_FIELDS = new Set(["password", "card6Digits", "otpLongTermToken"]);

/** Masks the first non-secret login field (username / id / userCode). */
function maskLogin(companyId: CompanyTypes, credentials: Record<string, string>) {
  const field = SCRAPERS[companyId].loginFields.find((f) => !SECRET_FIELDS.has(f));
  const value = field ? credentials[field] ?? "" : "";
  return value.length > 4 ? `•••${value.slice(-3)}` : "•••";
}

function connectionsCol(uid: string) {
  return adminDb.collection("users").doc(uid).collection("bankConnections");
}

function toConnection(id: string, data: FirebaseFirestore.DocumentData): BankConnection {
  return {
    id,
    companyId: data.companyId,
    status: data.status === "needs_attention" ? "needs_attention" : "active",
    maskedLogin: data.maskedLogin ?? "•••",
    lastErrorCode: data.lastErrorCode ?? null,
    lastSyncAt: (data.lastSyncAt as Timestamp | null)?.toDate() ?? null,
  };
}

export async function listConnections(uid: string): Promise<BankConnection[]> {
  const snapshot = await connectionsCol(uid).get();
  return snapshot.docs.map((d) => toConnection(d.id, d.data()));
}

export async function getConnection(uid: string, connectionId: string): Promise<BankConnection> {
  const snap = await connectionsCol(uid).doc(connectionId).get();
  if (!snap.exists) throw new ConnectionNotFoundError();
  return toConnection(snap.id, snap.data()!);
}

/**
 * Stores credentials for a provider, replacing the user's existing connection
 * to that provider if there is one (one saved login per provider). Call only
 * after the credentials logged in successfully.
 */
export async function saveConnection(
  uid: string,
  companyId: CompanyTypes,
  credentials: Record<string, string>,
  { synced }: { synced: boolean },
): Promise<BankConnection> {
  const existingId = await findConnectionId(uid, companyId);
  const connectionId = existingId ?? randomUUID();
  const { source, wrapper } = getVault();
  const envelope = await encryptCredentials(wrapper, uid, connectionId, credentials);

  const batch = adminDb.batch();
  batch.set(adminDb.collection(SECRETS).doc(connectionId), {
    uid,
    companyId,
    keySource: source,
    envelope,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    connectionsCol(uid).doc(connectionId),
    {
      companyId,
      status: "active",
      maskedLogin: maskLogin(companyId, credentials),
      lastErrorCode: null,
      ...(existingId ? {} : { createdAt: FieldValue.serverTimestamp(), lastSyncAt: null }),
      ...(synced && { lastSyncAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  await batch.commit();
  return getConnection(uid, connectionId);
}

/** Decrypts a connection's stored credentials. */
export async function loadCredentials(uid: string, connectionId: string) {
  const secret = await getOwnedSecret(uid, connectionId);
  const { source, wrapper } = getVault();
  if (secret.keySource !== source) {
    throw new CredentialVaultError(`Connection was saved with the ${secret.keySource} key, server is using ${source}`);
  }
  const credentials = await decryptCredentials(wrapper, uid, connectionId, secret.envelope);
  return { companyId: secret.companyId, credentials };
}

export async function updateConnectionStatus(
  uid: string,
  connectionId: string,
  update: { status?: ConnectionStatus; lastErrorCode: string | null; synced?: boolean },
) {
  const { synced, ...fields } = update;
  await connectionsCol(uid)
    .doc(connectionId)
    .update({ ...fields, ...(synced && { lastSyncAt: FieldValue.serverTimestamp() }) });
}

/** Deletes the secret and its status doc together. */
export async function deleteConnection(uid: string, connectionId: string) {
  await getOwnedSecret(uid, connectionId);
  const batch = adminDb.batch();
  batch.delete(adminDb.collection(SECRETS).doc(connectionId));
  batch.delete(connectionsCol(uid).doc(connectionId));
  await batch.commit();
}

/** The user's saved connection to `companyId`, if any (there is at most one per provider). */
export async function findConnectionId(uid: string, companyId: CompanyTypes): Promise<string | undefined> {
  const existing = await connectionsCol(uid).where("companyId", "==", companyId).limit(1).get();
  return existing.docs[0]?.id;
}

/** Every healthy connection, across all users, for the scheduled job to consider. */
export async function listActiveConnections(): Promise<{ uid: string; connection: BankConnection }[]> {
  const snapshot = await adminDb.collectionGroup("bankConnections").where("status", "==", "active").get();
  return snapshot.docs.map((d) => ({ uid: d.ref.parent.parent!.id, connection: toConnection(d.id, d.data()) }));
}

/**
 * How long a sync may hold a connection. Longer than the 120s scrape timeout
 * plus the Firestore writes, so a live sync never loses its lease; short
 * enough that a crashed instance only blocks the connection briefly.
 */
export const SYNC_LEASE_TTL_MS = 3 * 60 * 1000;

export type SyncLease =
  | { acquired: true; token: string; connection: BankConnection }
  | { acquired: false };

/**
 * Takes the connection's sync lease in a transaction, so at most one sync —
 * on any instance, from the API or the scheduled job — logs in to that bank
 * account at a time. Throws ConnectionNotFoundError if the doc is missing.
 */
export async function acquireSyncLease(uid: string, connectionId: string): Promise<SyncLease> {
  const ref = connectionsCol(uid).doc(connectionId);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ConnectionNotFoundError();
    const lockedUntil = (snap.get("syncLockUntil") as Timestamp | null | undefined)?.toMillis() ?? 0;
    if (lockedUntil > Date.now()) return { acquired: false } as const;

    const token = randomUUID();
    tx.update(ref, {
      syncLockUntil: Timestamp.fromMillis(Date.now() + SYNC_LEASE_TTL_MS),
      syncLeaseToken: token,
    });
    return { acquired: true, token, connection: toConnection(snap.id, snap.data()!) } as const;
  });
}

/**
 * Releases the lease if it's still ours. A sync that overran its TTL may have
 * been superseded by another; that newer lease must be left alone.
 */
export async function releaseSyncLease(uid: string, connectionId: string, token: string) {
  const ref = connectionsCol(uid).doc(connectionId);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("syncLeaseToken") !== token) return;
    tx.update(ref, { syncLockUntil: null, syncLeaseToken: null });
  });
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
