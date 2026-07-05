import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal signed-cookie session ("any simple session impl", doc 09 Phase 0).
 * The whole demo state (owned packs) lives in the cookie so the app needs no
 * database and works on Vercel serverless. Phase 11 (webhook attribution
 * testing) will need server-side state — tracked in PROGRESS.md.
 */
export interface DemoSession {
  email: string;
  /** unopened packs owned by this user */
  packs: number;
}

export const SESSION_COOKIE = "demo_session";

export function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-do-not-use-in-prod";
}

export function encodeSession(session: DemoSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function decodeSession(token: string, secret: string): DemoSession | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as DemoSession).email !== "string" ||
      typeof (parsed as DemoSession).packs !== "number"
    ) {
      return null;
    }
    const { email, packs } = parsed as DemoSession;
    return { email, packs };
  } catch {
    return null;
  }
}
