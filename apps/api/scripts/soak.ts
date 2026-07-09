/**
 * Phase 7 flake soak (doc 09 Phase 7 AC): re-orchestrate an unchanged run N
 * times; ANY non-green verdict (🟡/🔴/🟠) is a flake and fails the soak.
 * Deviation note: doc 09 runs this in CI (Phase 13); local loop for now.
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/soak.ts <runId> [iterations]
 */
import { Queue } from "bullmq";
import { sql as sqlTag } from "drizzle-orm";
import { createDb } from "@flowguard/db";

const runId = process.argv[2];
const iterations = Number(process.argv[3] ?? 20);
if (!runId) throw new Error("usage: soak.ts <runId> [iterations]");

const db = createDb();
const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const res = await db.execute(sqlTag(strings, ...values));
  return res.rows as Array<Record<string, unknown>>;
};
const u = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const queue = new Queue("orchestrate", {
  connection: { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null },
});

const GREEN = new Set(["passing", "already_broken_on_base"]);
let flakes = 0;

for (let i = 1; i <= iterations; i++) {
  await sql`update runs set state = 'planning' where id = ${runId}`;
  await queue.add(
    "orchestrate-run",
    { kind: "run", runId },
    { jobId: `orch-${runId}-soak${i}-${Date.now()}`, removeOnComplete: true, removeOnFail: { age: 3600 } },
  );

  const started = Date.now();
  let state = "planning";
  while (state !== "done" && state !== "failed") {
    if (Date.now() - started > 10 * 60_000) throw new Error(`iteration ${i}: run stuck in ${state}`);
    await new Promise((r) => setTimeout(r, 5000));
    const rows = await sql`select state from runs where id = ${runId}`;
    state = rows[0]!.state as string;
  }

  const verdicts = await sql`select flow_id, verdict, human_copy from verdicts where run_id = ${runId}`;
  const bad = verdicts.filter((v) => !GREEN.has(v.verdict as string));
  const line = verdicts.map((v) => `${v.flow_id}=${v.verdict}`).join(" ");
  if (state === "failed" || bad.length > 0) {
    flakes++;
    console.log(`[${i}/${iterations}] FLAKE state=${state} ${line}`);
    for (const b of bad) console.log(`    ${b.flow_id}: ${b.verdict} — ${b.human_copy}`);
  } else {
    console.log(`[${i}/${iterations}] ok (${((Date.now() - started) / 1000).toFixed(0)}s) ${line}`);
  }
}

console.log(flakes === 0 ? `SOAK PASS: ${iterations}/${iterations} green` : `SOAK FAIL: ${flakes} flaky iteration(s)`);
await queue.close();
process.exit(flakes === 0 ? 0 : 1);
