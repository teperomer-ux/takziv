import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";

/**
 * Envelope encryption for stored bank credentials.
 *
 * Each record gets its own random 256-bit data key (DEK). The credentials are
 * sealed locally with AES-256-GCM under that DEK, and the DEK itself is
 * wrapped by Cloud KMS. Only the wrapped DEK is stored, so reading a record
 * requires both the Firestore document and `cloudkms.cryptoKeyVersions.useToDecrypt`
 * on the key — which only the sync job's service account holds.
 *
 * Both layers bind the record to `uid` + `connectionId` as additional
 * authenticated data, so a ciphertext copied onto another user's or
 * connection's record fails to decrypt instead of logging in as them.
 */

export const ENVELOPE_VERSION = 1;

export interface CredentialEnvelope {
  v: typeof ENVELOPE_VERSION;
  /** DEK wrapped by KMS (base64). KMS picks the key version from the ciphertext itself. */
  wrappedDek: string;
  /** AES-GCM nonce (base64, 12 bytes). */
  iv: string;
  /** AES-GCM ciphertext of the credentials JSON (base64). */
  ciphertext: string;
  /** AES-GCM auth tag (base64, 16 bytes). */
  tag: string;
}

/** The KMS operations the vault needs; injectable so tests run without GCP. */
export interface KeyWrapper {
  wrap(plaintext: Buffer, aad: Buffer): Promise<Buffer>;
  unwrap(ciphertext: Buffer, aad: Buffer): Promise<Buffer>;
}

export class CredentialVaultError extends Error {}

/** Wraps data keys with a Cloud KMS symmetric key (projects/…/cryptoKeys/…). */
export function kmsKeyWrapper(keyName: string, client = new KeyManagementServiceClient()): KeyWrapper {
  return {
    async wrap(plaintext, aad) {
      const [res] = await client.encrypt({ name: keyName, plaintext, additionalAuthenticatedData: aad });
      if (!res.ciphertext) throw new CredentialVaultError("KMS returned no ciphertext");
      return Buffer.from(res.ciphertext as Uint8Array);
    },
    async unwrap(ciphertext, aad) {
      const [res] = await client.decrypt({ name: keyName, ciphertext, additionalAuthenticatedData: aad });
      if (!res.plaintext) throw new CredentialVaultError("KMS returned no plaintext");
      return Buffer.from(res.plaintext as Uint8Array);
    },
  };
}

/**
 * Wraps data keys with a local 256-bit key (AES-256-GCM), for running without
 * Cloud KMS. The key never leaves this machine, so the stored records are
 * unreadable without it — but anyone with both the key file and Firestore
 * access can decrypt, which KMS's separate IAM boundary would prevent.
 */
export function localKeyWrapper(key: Buffer): KeyWrapper {
  if (key.length !== 32) throw new CredentialVaultError("Local key must be 32 bytes");
  return {
    async wrap(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async unwrap(ciphertext, aad) {
      const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(0, 12), { authTagLength: 16 });
      decipher.setAAD(aad).setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    },
  };
}

function aadFor(uid: string, connectionId: string) {
  if (!uid || !connectionId) throw new CredentialVaultError("uid and connectionId are required");
  return Buffer.from(`takziv:bank-credentials:v${ENVELOPE_VERSION}:${uid}:${connectionId}`, "utf8");
}

export async function encryptCredentials(
  wrapper: KeyWrapper,
  uid: string,
  connectionId: string,
  credentials: Record<string, string>,
): Promise<CredentialEnvelope> {
  const aad = aadFor(uid, connectionId);
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");

  try {
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedDek = await wrapper.wrap(dek, aad);

    return {
      v: ENVELOPE_VERSION,
      wrappedDek: wrappedDek.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    };
  } finally {
    dek.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptCredentials(
  wrapper: KeyWrapper,
  uid: string,
  connectionId: string,
  envelope: CredentialEnvelope,
): Promise<Record<string, string>> {
  if (envelope?.v !== ENVELOPE_VERSION) throw new CredentialVaultError("Unsupported envelope version");
  const aad = aadFor(uid, connectionId);

  let dek: Buffer;
  try {
    dek = await wrapper.unwrap(Buffer.from(envelope.wrappedDek, "base64"), aad);
  } catch {
    // Don't surface KMS error details: they can echo request fields.
    throw new CredentialVaultError("Could not unwrap data key");
  }

  let plaintext: Buffer | undefined;
  try {
    // Pin the tag length: by default Node accepts truncated GCM tags.
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(envelope.iv, "base64"), {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new CredentialVaultError("Credential record failed integrity check");
  } finally {
    dek.fill(0);
    plaintext?.fill(0);
  }
}
