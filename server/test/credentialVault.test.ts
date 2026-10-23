import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CredentialVaultError,
  decryptCredentials,
  encryptCredentials,
  type KeyWrapper,
} from "../src/credentialVault.js";

// Stands in for Cloud KMS: like KMS, unwrap fails unless the AAD matches.
function fakeKms(): KeyWrapper {
  const kek = randomBytes(32);
  return {
    async wrap(plaintext, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", kek, iv).setAAD(aad);
      const body = Buffer.concat([c.update(plaintext), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    async unwrap(ciphertext, aad) {
      const d = createDecipheriv("aes-256-gcm", kek, ciphertext.subarray(0, 12)).setAAD(aad);
      d.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([d.update(ciphertext.subarray(28)), d.final()]);
    },
  };
}

const creds = { username: "israel", password: "s3cret-Pa55" };

test("round-trips credentials", async () => {
  const kms = fakeKms();
  const env = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  assert.deepEqual(await decryptCredentials(kms, "uid-1", "conn-1", env), creds);
});

test("stored envelope does not contain the plaintext", async () => {
  const env = await encryptCredentials(fakeKms(), "uid-1", "conn-1", creds);
  const stored = JSON.stringify(env);
  assert.ok(!stored.includes(creds.password));
  assert.ok(!stored.includes(Buffer.from(creds.password).toString("base64")));
});

test("each encryption uses a fresh data key and nonce", async () => {
  const kms = fakeKms();
  const a = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  const b = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  assert.notEqual(a.wrappedDek, b.wrappedDek);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("an envelope moved to another user or connection does not decrypt", async () => {
  const kms = fakeKms();
  const env = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  await assert.rejects(decryptCredentials(kms, "uid-2", "conn-1", env), CredentialVaultError);
  await assert.rejects(decryptCredentials(kms, "uid-1", "conn-2", env), CredentialVaultError);
});

test("tampering with any field is detected", async () => {
  const kms = fakeKms();
  const env = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  const flip = (b64: string) => {
    const buf = Buffer.from(b64, "base64");
    buf[0] ^= 1;
    return buf.toString("base64");
  };
  for (const field of ["ciphertext", "tag", "iv", "wrappedDek"] as const) {
    await assert.rejects(
      decryptCredentials(kms, "uid-1", "conn-1", { ...env, [field]: flip(env[field]) }),
      CredentialVaultError,
      field,
    );
  }
});

test("a truncated auth tag is rejected", async () => {
  const kms = fakeKms();
  const env = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  const short = Buffer.from(env.tag, "base64").subarray(0, 4).toString("base64");
  await assert.rejects(decryptCredentials(kms, "uid-1", "conn-1", { ...env, tag: short }), CredentialVaultError);
});

test("unknown envelope versions are rejected", async () => {
  const kms = fakeKms();
  const env = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  await assert.rejects(
    decryptCredentials(kms, "uid-1", "conn-1", { ...env, v: 2 as unknown as 1 }),
    CredentialVaultError,
  );
});

test("KMS failures don't leak their error details", async () => {
  const kms: KeyWrapper = {
    wrap: fakeKms().wrap,
    unwrap: async () => {
      throw new Error("PERMISSION_DENIED on projects/p/... aad=uid-1");
    },
  };
  const env = await encryptCredentials(kms, "uid-1", "conn-1", creds);
  await assert.rejects(decryptCredentials(kms, "uid-1", "conn-1", env), (err: Error) => {
    assert.ok(err instanceof CredentialVaultError);
    assert.ok(!err.message.includes("uid-1"));
    return true;
  });
});
