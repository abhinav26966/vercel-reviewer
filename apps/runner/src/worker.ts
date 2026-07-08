/**
 * BullMQ worker (doc 09 Phase 2 task 3): pulls ExecuteFlowJobs from the `runs`
 * queue, executes, returns the RunFlowResult as the job's return value.
 * Abort: orchestrator sets redis key `flowguard:abort:<runId>`; checked between steps.
 */
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { ExecuteFlowJobSchema } from "@flowguard/schemas";
import { createLogger } from "@flowguard/shared";
import { S3ArtifactStore } from "./artifacts.js";
import { loadRunnerEnv } from "./config.js";
import { executeFlow } from "./execute-flow.js";

const env = loadRunnerEnv();
const logger = createLogger({ name: "runner-worker", level: env.LOG_LEVEL });
const redisUrl = new URL(env.REDIS_URL);
const connectionOpts = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  maxRetriesPerRequest: null,
};
/** separate client for abort-key checks between steps */
const abortClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const RUNS_QUEUE = "runs";

const worker = new Worker(
  RUNS_QUEUE,
  async (bullJob) => {
    const job = ExecuteFlowJobSchema.parse(bullJob.data);
    logger.info({ runId: job.runId, flowId: job.flowId, target: job.target.kind }, "job started");
    const result = await executeFlow({
      job,
      logger,
      artifacts: new S3ArtifactStore(env),
      shouldAbort: async () => (await abortClient.exists(`flowguard:abort:${job.runId}`)) === 1,
    });
    logger.info({ runId: job.runId, status: result.status }, "job finished");
    return result;
  },
  { connection: connectionOpts, concurrency: 1 }, // one process, one job (doc 01 §2)
);

worker.on("failed", (job, err) => logger.error({ jobId: job?.id, err }, "job failed"));
logger.info({ queue: RUNS_QUEUE }, "runner worker listening");
