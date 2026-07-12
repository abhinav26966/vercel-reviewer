import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { RunFlowResultSchema, type ExecuteFlowJob, type RunFlowResult } from "@flowguard/schemas";

export const RUNS_QUEUE = "runs";
export const ORCHESTRATE_QUEUE = "orchestrate";

export type ControlJob =
  | { kind: "run"; runId: string }
  | { kind: "base-run"; runId: string }
  | { kind: "compile"; recordingId: string }
  | { kind: "validate"; versionId: string }
  | { kind: "nightly" }
  | { kind: "sweep" }
  | { kind: "purge" };

export interface QueueBundle {
  enqueueFlowJob: (job: ExecuteFlowJob, jobId: string) => Promise<void>;
  awaitFlowResult: (jobId: string, timeoutMs: number) => Promise<RunFlowResult>;
  removeQueuedJob: (jobId: string) => Promise<void>;
  setAbortKey: (runId: string) => Promise<void>;
  enqueueOrchestration: (runId: string) => Promise<void>;
  /** Re-enqueue an orchestration after a delay (per-project concurrency backoff). */
  deferOrchestration: (runId: string, delayMs: number) => Promise<void>;
  enqueueControl: (job: ControlJob) => Promise<void>;
  /** Repeatable cron jobs (doc 06 §6): nightly base runs, hourly sweep, daily purge. */
  registerSchedules: () => Promise<void>;
  startOrchestrateWorker: (handler: (job: ControlJob) => Promise<void>) => Worker;
  close: () => Promise<void>;
}

export function createQueues(redisUrl: string, logger: Logger): QueueBundle {
  const u = new URL(redisUrl);
  const connection = { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
  const runsQueue = new Queue(RUNS_QUEUE, { connection });
  const runsEvents = new QueueEvents(RUNS_QUEUE, { connection });
  const orchestrateQueue = new Queue(ORCHESTRATE_QUEUE, { connection });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  return {
    async enqueueFlowJob(job, jobId) {
      // deterministic jobIds dedupe within one orchestration, but a RERUN must
      // execute fresh — evict any finished job squatting on the id (a completed
      // job would otherwise satisfy awaitFlowResult with stale results)
      const existing = await runsQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState().catch(() => "unknown");
        if (state === "completed" || state === "failed") {
          await existing.remove().catch(() => {});
        }
      }
      await runsQueue.add("execute-flow", job, {
        jobId,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 3600 },
      });
    },
    async awaitFlowResult(jobId, timeoutMs) {
      const job = await runsQueue.getJob(jobId);
      if (!job) throw new Error(`flow job ${jobId} not found`);
      const raw: unknown = await job.waitUntilFinished(runsEvents, timeoutMs);
      return RunFlowResultSchema.parse(raw);
    },
    async removeQueuedJob(jobId) {
      const job = await runsQueue.getJob(jobId);
      if (job && (await job.isWaiting())) await job.remove().catch(() => {});
    },
    async setAbortKey(runId) {
      // runner checks flowguard:abort:<runId> between steps (apps/runner worker)
      await redis.set(`flowguard:abort:${runId}`, "1", "EX", 3600);
    },
    async enqueueOrchestration(runId) {
      await orchestrateQueue.add(
        "orchestrate-run",
        { kind: "run", runId } satisfies ControlJob,
        { jobId: `orch-${runId}-${Date.now()}`, removeOnComplete: true, removeOnFail: { age: 3600 } },
      );
    },
    async deferOrchestration(runId, delayMs) {
      await orchestrateQueue.add(
        "orchestrate-run",
        { kind: "run", runId } satisfies ControlJob,
        { jobId: `orch-${runId}-defer-${Date.now()}`, delay: delayMs, removeOnComplete: true, removeOnFail: { age: 3600 } },
      );
    },
    async enqueueControl(job) {
      await orchestrateQueue.add("control", job, {
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      });
    },
    async registerSchedules() {
      const schedules: Array<{ job: ControlJob; pattern: string }> = [
        { job: { kind: "nightly" }, pattern: "0 3 * * *" }, // nightly base runs
        { job: { kind: "sweep" }, pattern: "0 * * * *" }, // hourly stuck-run sweep
        { job: { kind: "purge" }, pattern: "30 4 * * *" }, // daily expiry purge
      ];
      for (const s of schedules) {
        await orchestrateQueue.add("control", s.job, {
          repeat: { pattern: s.pattern },
          jobId: `sched-${s.job.kind}`,
          removeOnComplete: true,
          removeOnFail: { age: 3600 },
        });
      }
    },
    startOrchestrateWorker(handler) {
      const worker = new Worker(
        ORCHESTRATE_QUEUE,
        async (job) => {
          const data = job.data as ControlJob | { runId: string };
          // legacy shape from earlier phases
          const control: ControlJob = "kind" in data ? data : { kind: "run", runId: data.runId };
          await handler(control);
        },
        // an orchestration awaits ALL its flow jobs inline, so a control job can
        // legitimately run for many minutes (slow canvas/vision/payment flows on
        // a small worker pool). Give it a long lock so BullMQ doesn't consider
        // it stalled mid-run; the stuck-run sweeper (doc 06 §6) is the real
        // backstop for genuine hangs.
        { connection, concurrency: 2, lockDuration: 20 * 60_000, stalledInterval: 5 * 60_000 },
      );
      worker.on("failed", (job, err) => logger.error({ jobId: job?.id, err }, "orchestration job failed"));
      return worker;
    },
    async close() {
      await Promise.all([runsQueue.close(), runsEvents.close(), orchestrateQueue.close(), redis.quit()]);
    },
  };
}
