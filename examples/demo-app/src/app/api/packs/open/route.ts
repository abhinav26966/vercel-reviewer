import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, decodeSession, sessionSecret } from "@/lib/session";
import { withSession } from "@/lib/session-server";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? decodeSession(token, sessionSecret()) : null;
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Chaos flag: ?break=rip makes this route return 500 (doc 09 Phase 0e).
  if (req.nextUrl.searchParams.get("break") === "rip") {
    return NextResponse.json({ error: "rip service exploded (chaos flag)" }, { status: 500 });
  }

  // Env chaos: BREAK_RIP=1 breaks this route deployment-wide — lets base-branch
  // breakage be simulated via an env flip + redeploy, no merge required.
  if (process.env.BREAK_RIP === "1") {
    return NextResponse.json({ error: "rip service exploded (env chaos)" }, { status: 500 });
  }

  if (session.packs < 1) {
    return NextResponse.json({ error: "no unopened packs" }, { status: 400 });
  }

  const packs = session.packs - 1;
  const res = NextResponse.json({ ok: true, packs, cards: 5 });
  return withSession(res, { ...session, packs });
}
