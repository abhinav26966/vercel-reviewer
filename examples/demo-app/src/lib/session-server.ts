import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { DemoSession } from "./session";
import { SESSION_COOKIE, decodeSession, encodeSession, sessionSecret } from "./session";

export async function getSession(): Promise<DemoSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? decodeSession(token, sessionSecret()) : null;
}

export function withSession(res: NextResponse, session: DemoSession): NextResponse {
  res.cookies.set(SESSION_COOKIE, encodeSession(session, sessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
}

export function clearSession(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
