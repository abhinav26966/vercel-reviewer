import { NextResponse, type NextRequest } from "next/server";
import { checkCredentials } from "@/lib/users";
import { withSession } from "@/lib/session-server";
import { SESSION_COOKIE, decodeSession, sessionSecret } from "@/lib/session";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  if (!checkCredentials(email, password)) {
    return NextResponse.redirect(new URL("/login?error=1", req.url), 303);
  }

  // Preserve an existing pack count if the same user re-logs-in with a live cookie.
  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  const prior = existing ? decodeSession(existing, sessionSecret()) : null;
  const packs = prior?.email === email ? prior.packs : 0;

  const res = NextResponse.redirect(new URL("/shop", req.url), 303);
  return withSession(res, { email, packs });
}
