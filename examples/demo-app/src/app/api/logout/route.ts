import { NextResponse, type NextRequest } from "next/server";
import { clearSession } from "@/lib/session-server";

export async function POST(req: NextRequest) {
  return clearSession(NextResponse.redirect(new URL("/", req.url), 303));
}
