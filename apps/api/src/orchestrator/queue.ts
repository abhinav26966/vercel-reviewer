import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { RunFlowResultSchema, type ExecuteFlowJob, type RunFlowResult } from "@flowguard/schemas";

export const RUNS_QUEUE = "runs";
export const ORCHESTRATE_QUEUE = "orchestrate";

export interface QueueBundle {
  enqueueFlowJob: (job: ExecuteFlowJob, jobId: string) => Promise<void>;
  awaitFlowResult: (jobId: string, timeoutMs: number) => Promise<RunFlowResult>;
  removeQueuedJob: (jobId: string) => Promise<void>;
  setAbortKey: (runId: string) => Promise<void>;
  enqueueOrchestration: (runId: string) => Promise<void>;
  startOrchestrateWorker: (handler: (runId: string) => Promise<void>) => Worker;
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
        { runId },
        { jobId: `orch:${runId}:${Date.now()}`, removeOnComplete: true, removeOnFail: { age: 3600 } },
      );
    },
    startOrchestrateWorker(handler) {
      const worker = new Worker(
        ORCHESTRATE_QUEUE,
        async (job) => handler((job.data as { runId: string }).runId),
        { connection, concurrency: 2 },
      );
      worker.on("failed", (job, err) => logger.error({ jobId: job?.id, err }, "orchestration job failed"));
      return worker;
    },
    async close() {
      await Promise.all([runsQueue.close(), runsEvents.close(), orchestrateQueue.close(), redis.quit()]);
    },
  };
}
