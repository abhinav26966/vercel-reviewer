import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowGuard",
  description: "GUI-level PR reviewer for Vercel previews",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">🛡️ FlowGuard</Link>
          <span className="muted">dashboard v0 — local dev, no auth (Phase 13)</span>
        </nav>
        {children}
      </body>
    </html>
  );
}
