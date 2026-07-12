/** Phase 12 AC: two focused canvas rip flows (mock-payment, no Stripe) —
 *  one exposing the state SDK (/open), one vision-only (/open?nosdk=1). */
import { FlowSpecSchema } from "@flowguard/schemas";
import { createDb, flows, flowSpecVersions } from "@flowguard/db";
import { newId } from "@flowguard/shared";
import { eq, and } from "drizzle-orm";

const db = createDb();
const projectId = "prj_862ymcrku4xal4";

function build(name: string, openPath: string) {
  return FlowSpecSchema.parse({
    specVersion: 3, flowId: "P", projectId, name, persona: "default", startPath: "/shop",
    viewport: { width: 1280, height: 800, dpr: 1 },
    steps: [
      { id: "s1", title: "Buy a pack (mock)",
        action: { type: "click", locators: [{ kind: "testid", value: "purchase-btn" }, { kind: "text", value: "Buy a Pack" }] },
        settle: { strategy: "navigation", timeoutMs: 15000 },
        postConditions: [{ kind: "url", assert: "pathMatches", value: "^/shop/success$" }], timingBaselineKey: "s1" },
      { id: "s2", title: "Go to Open Packs",
        action: { type: "navigate", path: openPath },
        settle: { strategy: "networkidle", timeoutMs: 8000 },
        postConditions: [{ kind: "url", assert: "pathMatches", value: "^/open" }], timingBaselineKey: "s2" },
      { id: "s3", title: "Rip open the pack",
        action: { type: "canvasClick", point: { nx: 0.5014, ny: 0.5013 },
          canvasLocator: [{ kind: "testid", value: "pack-canvas" }, { kind: "css", value: "div > div > div > canvas" }],
          visionFallback: { describe: "the glowing 3D pack in the center of the canvas" } },
        settle: { strategy: "animationQuiescence", timeoutMs: 15000, quiescence: { stableFrames: 3, sampleEveryMs: 500, diffThresholdPct: 1.5 } },
        postConditions: [
          { kind: "state", read: "window.__flowState.cardsRevealed", assert: "equals", value: 5, optional: true, description: "SDK exact read" },
          { kind: "vision", question: "How many cards are revealed on screen?", assert: "equals", value: 5, description: "vision fallback" },
        ], timingBaselineKey: "s3" },
    ],
  });
}

async function upsert(name: string, openPath: string) {
  const spec = build(name, openPath);
  const existing = await db.select({ id: flows.id }).from(flows).where(and(eq(flows.projectId, projectId), eq(flows.name, name))).limit(1);
  let fid = newId("flow");
  if (existing[0]) { fid = existing[0].id; await db.update(flowSpecVersions).set({ status: "archived" }).where(eq(flowSpecVersions.flowId, fid)); await db.update(flows).set({ archived: false }).where(eq(flows.id, fid)); }
  else await db.insert(flows).values({ id: fid, projectId, name, tier: "smoke", persona: "default", archived: false });
  spec.flowId = fid;
  const vid = newId("flowSpecVersion");
  await db.insert(flowSpecVersions).values({ id: vid, flowId: fid, spec, status: "official", branch: "main", source: "recording", sourceRecordingId: null });
  console.log(name, "→", fid, vid);
}

await upsert("Rip (canvas SDK)", "/open");
await upsert("Rip (canvas vision)", "/open?nosdk=1");
process.exit(0);
