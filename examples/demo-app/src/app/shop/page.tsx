import { redirect } from "next/navigation";
import { getSession } from "@/lib/session-server";

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ slow?: string; error?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { slow, error } = await searchParams;
  const buyAction = `/api/packs/buy${slow === "1" ? "?slow=1" : ""}`;

  return (
    <main>
      <h1>Shop</h1>
      <p className="muted">
        You own <span data-testid="owned-packs">{session.packs}</span> unopened pack(s).
      </p>
      {error === "payment" ? (
        <p className="error" data-testid="payment-error">
          Payment was not completed.
        </p>
      ) : null}
      <div className="grid" id="shop-grid">
        <div className="pack-tile">
          <h3>Starter Pack</h3>
          <p className="muted">Exactly 5 random cards</p>
          <p>$1.99</p>
          <form action={buyAction} method="POST">
            <button type="submit" data-testid="buy-pack-btn">
              Buy Pack
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
