import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/lib/session-server";
import "./globals.css";

export const metadata: Metadata = {
  title: "PackDemo — FlowGuard test target",
  description: "Demo Next.js app: login, Stripe test checkout, 3D pack opening",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">PackDemo</Link>
          <Link href="/shop">Shop</Link>
          <Link href="/inventory">Inventory</Link>
          <Link href="/open">Open Packs</Link>
          <span className="spacer" />
          {session ? (
            <>
              <span className="who" data-testid="session-email">
                {session.email}
              </span>
              <form action="/api/logout" method="POST">
                <button type="submit" data-testid="logout-btn">
                  Log out
                </button>
              </form>
            </>
          ) : (
            <Link href="/login" data-testid="nav-login">
              Log in
            </Link>
          )}
        </nav>
        {children}
      </body>
    </html>
  );
}
