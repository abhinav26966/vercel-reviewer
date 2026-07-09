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

  // "refactor": inventory service extraction left this endpoint pointing nowhere
  return NextResponse.json({ error: "inventory service unavailable" }, { status: 500 });
}
