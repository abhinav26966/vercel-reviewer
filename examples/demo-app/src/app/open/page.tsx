import { redirect } from "next/navigation";
import { getSession } from "@/lib/session-server";
import OpenClient from "@/components/OpenClient";

export default async function OpenPage({
  searchParams,
}: {
  searchParams: Promise<{ break?: string; nosdk?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const params = await searchParams;

  return (
    <main>
      <h1>Open Packs</h1>
      {/* ?nosdk=1 disables the state SDK at runtime → FlowGuard must verify the
          canvas outcome by vision alone (the zero-integration story). */}
      <OpenClient
        initialPacks={session.packs}
        breakFlag={params.break ?? null}
        sdkDisabled={params.nosdk === "1"}
      />
    </main>
  );
}
