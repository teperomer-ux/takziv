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
  openJson,
  sealJson,
  type CredentialEnvelope,
  type KeyWrapper,
} from "./credentialVault.js";
import { isUsableSession, type BrowserSession } from "./browserSession.js";
import { loadOrCreateLocalKey } from "./localKey.js";
import { SCRAPE_TIMEOUT_MS } from "./syncSupport.js";

/**
 * Storage for saved bank connections, split in two:
 *
 *   bankSecrets/{connectionId}                  encrypted credentials, and the
 *                                               encrypted browser session (the
 *                                               device state the bank set on the
 *                                               last login). Firestore rules deny
 *                                               every client read and write; only
 *                                               the Admin SDK reaches it.
 *   users/{uid}/bankConnections/{connectionId}  non-secret status (provider,
 *                                               masked login, last sync, when the
 *                                               session was saved) that the API
 *                                               returns to the owner, plus the
 *                                               sync lease (syncLockUntil,
 *                                               syncLeaseToken).
 *
 * Credentials are wrapped with Cloud KMS when KMS_CREDENTIALS_KEY is set, and
 * otherwise with a local key file (server/.secrets/credentials.key).
 */

const SECRETS = "bankSecrets";

/**
 *  syncing          credentials saved by POST /api/connections but not yet
 *                   confirmed by a login; the first sync (POST …/:id/sync,
 *                   fired by the client right after) settles it. If that sync
 *                   fails for a reason that isn't the login's fault (timeout,
 *                   busy server) it stays here with lastErrorCode set. The
 *                   scheduled job never picks it up: only a login the user
 *                   started may try unverified credentials.
 *  active           the saved login worked
 *  needs_attention  the bank rejected the login / wants OTP or a password change
 */
export type ConnectionStatus = "syncing" | "active" | "needs_attention";
type KeySource = "kms" | "local";

const STATUSES: ReadonlySet<string> = new Set<ConnectionStatus>(["syncing", "active", "needs_attention"]);

export interface BankConnection {
  id: string;
  companyId: CompanyTypes;
  status: ConnectionStatus;
  /** True while some sync holds the connection's lease, i.e. a login is running right now. */
  syncInProgress: boolean;
  /**
   * The bank accepted the credentials currently saved. Reset to false when new
   * credentials are saved; set by the first sync the moment the login gets
   * through — before the transactions are fetched — so the client can stop
   * waiting on the login and let the fetch finish in the background.
   */
  loginVerified: boolean;
  /** e.g. "•••789" — the last characters of the login identifier, never a secret field. */
  maskedLogin: string;
  /** API error code of the last failed sync, cleared on success. */
  lastErrorCode: string | null;
  lastSyncAt: Date | null;
  /** YYYY-MM-DD the user wants transactions fetched from; null for connections saved before it existed. */
  startDate: string | null;
  /** YYYY-MM-DD back to which transactions have actually been fetched. */
  syncedFrom: string | null;
  /** When the browser session (trusted-device state) was last captured; null if never. */
  sessionSavedAt: Date | null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdOrNull = (v: unknown) => (typeof v === "string" && YMD.test(v) ? v : null);

interface SecretDoc {
  uid: string;
  companyId: CompanyTypes;
  keySource: KeySource;
  envelope: CredentialEnvelope;
  /** Absent until the first login that got through. */
  session?: { keySource: KeySource; envelope: CredentialEnvelope; savedAt: Timestamp };
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

export function toConnection(id: string, data: FirebaseFirestore.DocumentData, now = Date.now()): BankConnection {
  // Docs written before "syncing" existed have only the two older values.
  const status: ConnectionStatus = STATUSES.has(data.status) ? data.status : "active";
  return {
    id,
    companyId: data.companyId,
    status,
    syncInProgress: ((data.syncLockUntil as Timestamp | null | undefined)?.toMillis() ?? 0) > now,
    // Absent on docs saved before this field existed: those logged in fine unless flagged.
    loginVerified: typeof data.loginVerified === "boolean" ? data.loginVerified : status === "active",
    maskedLogin: data.maskedLogin ?? "•••",
    lastErrorCode: data.lastErrorCode ?? null,
    lastSyncAt: (data.lastSyncAt as Timestamp | null)?.toDate() ?? null,
    startDate: ymdOrNull(data.startDate),
    syncedFrom: ymdOrNull(data.syncedFrom),
    sessionSavedAt: (data.sessionSavedAt as Timestamp | null | undefined)?.toDate() ?? null,
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
 * Stores credentials for a provider as status "syncing" (not yet confirmed by
 * a login), updating `connectionId` — the user's existing connection to that
 * provider — when given, else creating one (one saved login per provider).
 * Use saveUnverifiedConnection (connectionSync.ts), which holds the lease.
 *
 * Re-saving keeps the connection id — and with it the transactions, start
 * date, sync history and the stored browser session (the device trust) —
 * and clears the previous error.
 */
export async function saveConnection(
  uid: string,
  companyId: CompanyTypes,
  credentials: Record<string, string>,
  { connectionId: existingId, startDate }: { connectionId?: string; startDate: string },
): Promise<BankConnection> {
  const connectionId = existingId ?? randomUUID();
  const { source, wrapper } = getVault();
  const envelope = await encryptCredentials(wrapper, uid, connectionId, credentials);

  const batch = adminDb.batch();
  batch.set(
    adminDb.collection(SECRETS).doc(connectionId),
    { uid, companyId, keySource: source, envelope, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  batch.set(
    connectionsCol(uid).doc(connectionId),
    {
      companyId,
      status: "syncing",
      loginVerified: false,
      maskedLogin: maskLogin(companyId, credentials),
      lastErrorCode: null,
      ...(existingId ? {} : { createdAt: FieldValue.serverTimestamp(), lastSyncAt: null, sessionSavedAt: null }),
      startDate,
    },
    { merge: true },
  );
  await batch.commit();
  return getConnection(uid, connectionId);
}

/**
 * Decrypts a connection's stored credentials, and the browser session saved
 * with them if there is a usable one. A session that can't be read (saved
 * under another key, corrupt, too old) is simply reported as absent: the
 * scrape still works without it, it just may be asked for a one-time code.
 */
export async function loadCredentials(uid: string, connectionId: string) {
  const secret = await getOwnedSecret(uid, connectionId);
  const { source, wrapper } = getVault();
  if (secret.keySource !== source) {
    throw new CredentialVaultError(`Connection was saved with the ${secret.keySource} key, server is using ${source}`);
  }
  const credentials = await decryptCredentials(wrapper, uid, connectionId, secret.envelope);
  return { companyId: secret.companyId, credentials, session: await openSession(uid, connectionId, secret) };
}

/** The connection's saved browser session, or null when there is none it can use. Never throws. */
export async function loadSession(uid: string, connectionId: string): Promise<BrowserSession | null> {
  try {
    return await openSession(uid, connectionId, await getOwnedSecret(uid, connectionId));
  } catch {
    return null;
  }
}

async function openSession(uid: string, connectionId: string, secret: SecretDoc): Promise<BrowserSession | null> {
  const stored = secret.session;
  if (!stored) return null;
  const { source, wrapper } = getVault();
  if (stored.keySource !== source) return null;
  try {
    const session = await openJson<BrowserSession>(wrapper, uid, connectionId, stored.envelope, "bank-session");
    return isUsableSession(session) ? session : null;
  } catch (err) {
    console.warn(JSON.stringify({ event: "session_unreadable", connectionId, error: String(err) }));
    return null;
  }
}

async function sealSession(uid: string, connectionId: string, session: BrowserSession) {
  const { source, wrapper } = getVault();
  const savedAt = Timestamp.fromMillis(session.savedAt);
  const envelope = await sealJson(wrapper, uid, connectionId, session, "bank-session");
  return { secret: { keySource: source, envelope, savedAt }, savedAt };
}

/**
 * Stores the browser session captured by a scrape of this connection,
 * replacing the previous one. Only the owner's connection is written.
 */
export async function saveSession(uid: string, connectionId: string, session: BrowserSession) {
  await getOwnedSecret(uid, connectionId);
  const { secret, savedAt } = await sealSession(uid, connectionId, session);
  const batch = adminDb.batch();
  batch.update(adminDb.collection(SECRETS).doc(connectionId), { session: secret });
  batch.update(connectionsCol(uid).doc(connectionId), { sessionSavedAt: savedAt });
  await batch.commit();
}

export async function updateConnectionStatus(
  uid: string,
  connectionId: string,
  update: {
    status?: ConnectionStatus;
    lastErrorCode: string | null;
    synced?: boolean;
    syncedFrom?: string;
    loginVerified?: boolean;
  },
) {
  const { synced, ...fields } = update;
  await connectionsCol(uid)
    .doc(connectionId)
    .update({ ...fields, ...(synced && { lastSyncAt: FieldValue.serverTimestamp() }) });
}

/** Records that the bank just accepted this connection's saved login (see BankConnection.loginVerified). */
export async function markLoginVerified(uid: string, connectionId: string) {
  await connectionsCol(uid).doc(connectionId).update({ loginVerified: true });
}

/** Sets the date future syncs fetch from. A date before `syncedFrom` makes the next sync backfill to it. */
export async function updateConnectionStartDate(uid: string, connectionId: string, startDate: string) {
  try {
    await connectionsCol(uid).doc(connectionId).update({ startDate });
  } catch (err) {
    // gRPC NOT_FOUND: update() requires the doc to exist.
    if ((err as { code?: number }).code === 5) throw new ConnectionNotFoundError();
    throw err;
  }
  return getConnection(uid, connectionId);
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
 * How long a sync may hold a connection. Longer than the scrape timeout plus
 * the Firestore writes, so a live sync never loses its lease; short enough
 * that a crashed instance only blocks the connection briefly.
 */
export const SYNC_LEASE_TTL_MS = SCRAPE_TIMEOUT_MS + 60 * 1000;

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
