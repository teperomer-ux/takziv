import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// build/server/src/localKey.js → server/.secrets/credentials.key
const DEFAULT_KEY_FILE = fileURLToPath(new URL("../../../.secrets/credentials.key", import.meta.url));

/**
 * The local key that wraps stored bank credentials when Cloud KMS isn't
 * configured. Created on first use; git- and docker-ignored. Losing it means
 * every saved connection has to be re-entered (nothing else breaks).
 */
export function loadOrCreateLocalKey(file = process.env.LOCAL_CREDENTIALS_KEY_FILE || DEFAULT_KEY_FILE): Buffer {
  try {
    return decode(readFileSync(file, "utf8"), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  try {
    // "wx" fails if another process created it in the meantime; mode is POSIX-only.
    writeFileSync(file, key.toString("base64") + "\n", { flag: "wx", mode: 0o600 });
    console.info(JSON.stringify({ event: "local_key_created", file }));
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return decode(readFileSync(file, "utf8"), file);
    throw err;
  }
}

function decode(text: string, file: string) {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} does not contain a 32-byte base64 key`);
  return key;
}
