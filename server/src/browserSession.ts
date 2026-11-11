import type { Browser, Cookie, CookieData, Page } from "puppeteer";

/**
 * The browser state a bank uses to recognise a device between logins —
 * persistent cookies plus localStorage of the bank's origins — captured from a
 * finished scrape and seeded into the next one.
 *
 * Why this exists: every scrape runs in a brand-new headless Chromium. Without
 * carrying this state over, the bank sees a never-before-seen device on every
 * sync and, for banks that gate unknown devices behind an SMS code, demands
 * a one-time code the scraper can't supply. The scrape then fails and the
 * connection gets flagged — which is what forced the user to re-authenticate
 * so often.
 *
 * Only persistent cookies are kept. Session cookies (no expiry) belong to the
 * login that just ended; replaying them can land the next login on a stale
 * "session expired" page the scraper doesn't recognise.
 */

export const SESSION_VERSION = 1;

/** Upper bound on the serialised session; a bank's device state is a few KB, so this is only a safety net. */
export const MAX_SESSION_BYTES = 256 * 1024;

/** Sessions older than this are not restored: whatever trust they carried has long been revoked by the bank. */
export const MAX_SESSION_AGE_MS = 90 * 86_400_000;

export interface BrowserSession {
  v: typeof SESSION_VERSION;
  /** Unix ms when the session was captured. */
  savedAt: number;
  cookies: CookieData[];
  /** localStorage entries by origin (e.g. "https://login.bankhapoalim.co.il"). */
  localStorage: Record<string, Record<string, string>>;
}

// CookieData fields worth carrying over; the rest of Cookie (size, session, …) is read-only state.
const COOKIE_FIELDS = [
  "name",
  "value",
  "domain",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "expires",
  "priority",
  "sameParty",
  "sourceScheme",
  "partitionKey",
] as const satisfies readonly (keyof CookieData)[];

/** A persistent cookie that hasn't expired by `now` (unix ms). */
export function isPersistentCookie(cookie: Pick<Cookie, "expires"> | CookieData, now = Date.now()): boolean {
  const { expires } = cookie;
  return typeof expires === "number" && expires > 0 && expires * 1000 > now;
}

/** Drops session and expired cookies and strips cookies to the fields CookieData accepts. */
export function persistentCookies(cookies: Cookie[], now = Date.now()): CookieData[] {
  return cookies
    .filter((c) => isPersistentCookie(c, now))
    .map((c) => {
      const data: Partial<CookieData> = {};
      for (const field of COOKIE_FIELDS) {
        if (c[field] !== undefined) (data as Record<string, unknown>)[field] = c[field];
      }
      return data as CookieData;
    });
}

/** The session is well-formed, recent enough to be useful, and has something in it. */
export function isUsableSession(session: unknown, now = Date.now()): session is BrowserSession {
  const s = session as Partial<BrowserSession> | null | undefined;
  if (!s || s.v !== SESSION_VERSION || typeof s.savedAt !== "number") return false;
  if (now - s.savedAt > MAX_SESSION_AGE_MS) return false;
  if (!Array.isArray(s.cookies) || typeof s.localStorage !== "object" || s.localStorage === null) return false;
  return s.cookies.length > 0 || Object.keys(s.localStorage).length > 0;
}

/** Serialised size check, so a runaway page can't push the Firestore document over its limit. */
export function sessionFits(session: BrowserSession): boolean {
  return Buffer.byteLength(JSON.stringify(session), "utf8") <= MAX_SESSION_BYTES;
}

/**
 * Captures cookies and the localStorage of every origin the scrape touched
 * that is still reachable through an open frame. Returns null when there is
 * nothing worth keeping.
 */
export async function exportBrowserSession(browser: Browser, now = Date.now()): Promise<BrowserSession | null> {
  const cookies = persistentCookies(await browser.cookies().catch(() => [] as Cookie[]), now);

  const storesByOrigin: BrowserSession["localStorage"] = {};
  for (const page of await browser.pages().catch(() => [] as Page[])) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (!/^https?:/.test(url)) continue;
      const entries = await frame
        .evaluate(() => {
          const out: Record<string, string> = {};
          const store = window.localStorage;
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key !== null) out[key] = store.getItem(key) ?? "";
          }
          return { origin: window.location.origin, items: out };
        })
        .catch(() => null); // detached / cross-origin frame without access
      if (entries && Object.keys(entries.items).length) {
        storesByOrigin[entries.origin] = { ...storesByOrigin[entries.origin], ...entries.items };
      }
    }
  }

  const session: BrowserSession = { v: SESSION_VERSION, savedAt: now, cookies, localStorage: storesByOrigin };
  return isUsableSession(session, now) && sessionFits(session) ? session : null;
}

/**
 * Seeds a fresh browser with a saved session before the scraper navigates
 * anywhere: cookies go straight into the cookie jar; localStorage is written
 * by an init script on the first document of each matching origin, where keys
 * the page has since written itself are left alone.
 */
export async function restoreBrowserSession(browser: Browser, page: Page, session: BrowserSession, now = Date.now()) {
  const cookies = session.cookies.filter((c) => isPersistentCookie(c, now));
  if (cookies.length) await browser.setCookie(...cookies);

  if (Object.keys(session.localStorage).length) {
    await page.evaluateOnNewDocument((stores: BrowserSession["localStorage"]) => {
      const items = stores[window.location.origin];
      if (!items) return;
      try {
        const store = window.localStorage;
        for (const [key, value] of Object.entries(items)) {
          if (store.getItem(key) === null) store.setItem(key, value);
        }
      } catch {
        // Storage disabled for this document; nothing to restore.
      }
    }, session.localStorage);
  }
}
