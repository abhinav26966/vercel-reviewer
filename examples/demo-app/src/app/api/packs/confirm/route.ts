import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";
import { SESSION_COOKIE, decodeSession, sessionSecret } from "@/lib/session";
import { withSession } from "@/lib/session-server";

/** Stripe Checkout success redirect lands here; verifies payment, then credits the pack. */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? decodeSession(token, sessionSecret()) : null;
  if (!session) {
    return NextResponse.redirect(new URL("/login", req.url), 303);
  }

  const checkoutSessionId = req.nextUrl.searchParams.get("session_id");
  if (!checkoutSessionId || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.redirect(new URL("/shop?error=payment", req.url), 303);
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const checkout = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  if (checkout.payment_status !== "paid") {
    return NextResponse.redirect(new URL("/shop?error=payment", req.url), 303);
  }

  const res = NextResponse.redirect(new URL("/shop/success", req.url), 303);
  return withSession(res, { ...session, packs: session.packs + 1 });
}
