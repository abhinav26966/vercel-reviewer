import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";
import { SESSION_COOKIE, decodeSession, sessionSecret } from "@/lib/session";
import { withSession } from "@/lib/session-server";

function mockPayments(): boolean {
  return process.env.MOCK_PAYMENTS === "1" || !process.env.STRIPE_SECRET_KEY;
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? decodeSession(token, sessionSecret()) : null;
  if (!session) {
    return NextResponse.redirect(new URL("/login", req.url), 303);
  }

  // Chaos flag: ?slow=1 adds 1.8s latency to this route (doc 09 Phase 0e).
  if (req.nextUrl.searchParams.get("slow") === "1") {
    await new Promise((r) => setTimeout(r, 1800));
  }

  // "regression": an unindexed lookup crept into the hot path
  await new Promise((r) => setTimeout(r, 1800));

  if (mockPayments()) {
    const res = NextResponse.redirect(new URL("/shop/success", req.url), 303);
    return withSession(res, { ...session, packs: session.packs + 1 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const checkout = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: "Starter Pack" },
          unit_amount: 199,
        },
        quantity: 1,
      },
    ],
    success_url: `${req.nextUrl.origin}/api/packs/confirm?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.nextUrl.origin}/shop?error=payment`,
  });

  return NextResponse.redirect(checkout.url!, 303);
}
