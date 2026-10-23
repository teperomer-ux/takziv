import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialVaultError, decryptCredentials, encryptCredentials, localKeyWrapper } from "../src/credentialVault.js";
import { loadOrCreateLocalKey } from "../src/localKey.js";

test("creates the key file once and reloads the same key", () => {
  const dir = mkdtempSync(join(tmpdir(), "takziv-key-"));
  try {
    const file = join(dir, "nested", "credentials.key");
    const first = loadOrCreateLocalKey(file);
    assert.equal(first.length, 32);
    assert.deepEqual(loadOrCreateLocalKey(file), first);
    assert.equal(Buffer.from(readFileSync(file, "utf8").trim(), "base64").length, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentials sealed with the local key round-trip, and fail under another key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takziv-key-"));
  try {
    const wrapper = localKeyWrapper(loadOrCreateLocalKey(join(dir, "a.key")));
    const other = localKeyWrapper(loadOrCreateLocalKey(join(dir, "b.key")));
    const creds = { username: "israel", password: "s3cret" };
    const env = await encryptCredentials(wrapper, "uid-1", "conn-1", creds);
    assert.deepEqual(await decryptCredentials(wrapper, "uid-1", "conn-1", env), creds);
    await assert.rejects(decryptCredentials(other, "uid-1", "conn-1", env), CredentialVaultError);
    await assert.rejects(decryptCredentials(wrapper, "uid-2", "conn-1", env), CredentialVaultError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
