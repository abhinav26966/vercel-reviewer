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

  if (session.packs < 1) {
    return NextResponse.json({ error: "no unopened packs" }, { status: 400 });
  }

  const packs = session.packs - 1;
  // regression under test (Phase 3 AC): the "streamlined" service crashes instead
  // of responding. `withSession` intentionally untouched so the diff stays minimal.
  void packs;
  void withSession;
  return NextResponse.json({ error: "inventory service crashed" }, { status: 500 });
}
