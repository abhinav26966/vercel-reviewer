import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session-server";

export default async function SuccessPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <main>
      <h1 data-testid="purchase-complete">Purchase complete</h1>
      <p>
        Your pack was added to your inventory. You now own{" "}
        <span data-testid="owned-packs">{session.packs}</span> unopened pack(s).
      </p>
      <p>
        <Link className="btn" href="/inventory">
          View inventory
        </Link>{" "}
        <Link className="btn" href="/open">
          Open it
        </Link>
      </p>
    </main>
  );
}
