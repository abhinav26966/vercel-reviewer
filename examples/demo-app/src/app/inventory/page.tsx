import { redirect } from "next/navigation";
import { getSession } from "@/lib/session-server";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ blank?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { blank } = await searchParams;

  // Chaos flag: ?blank=1 renders an empty page (doc 09 Phase 0e).
  if (blank === "1") {
    return <main />;
  }

  return (
    <main>
      <h1>Inventory</h1>
      {session.packs === 0 ? (
        <p className="muted" data-testid="inventory-empty">
          No unopened packs. Buy one in the shop.
        </p>
      ) : (
        <div className="grid">
          {Array.from({ length: session.packs }, (_, i) => (
            <div className="pack-tile" data-testid="pack-card" key={i}>
              <h3>Starter Pack</h3>
              <p className="muted">unopened</p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
