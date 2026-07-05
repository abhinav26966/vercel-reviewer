import { redirect } from "next/navigation";
import { getSession } from "@/lib/session-server";
import OpenClient from "@/components/OpenClient";

export default async function OpenPage({
  searchParams,
}: {
  searchParams: Promise<{ break?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const params = await searchParams;

  return (
    <main>
      <h1>Open Packs</h1>
      <OpenClient initialPacks={session.packs} breakFlag={params.break ?? null} />
    </main>
  );
}
