import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createDb, secrets } from "@flowguard/db";
import { eq } from "drizzle-orm";
import { createGithubApp, decodePrivateKey } from "@flowguard/github";
import { createLogger, decryptSecret, parseMasterKey } from "@flowguard/shared";
import { VercelClient } from "@flowguard/vercel";
import { createInferenceFromEnv } from "@flowguard/inference";
import { buildApp } from "./app.js";
import { compileRecording } from "./compiler/compile.js";
import { draftFromDescription } from "./compiler/plain-language.js";
import { validateDraft } from "./compiler/validate.js";
import { loadEnv } from "./env.js";
import { encryptSecret } from "@flowguard/shared";
import { artifactLinkBuilder, signArtifactKey, verifyArtifactSig } from "./orchestrator/artifact-links.js";
import { orchestrateRun, type OrchestratorDeps } from "./orchestrator/orchestrate.js";
import { orchestrateBaseRun } from "./orchestrator/base-run.js";
import { nightlyBaseRuns, purgeExpired, startBaseRun, sweepStuckRuns } from "./orchestrator/scheduler.js";
import { createQueues } from "./orchestrator/queue.js";
import { DrizzleStore } from "./store.js";

const env = loadEnv();
const logger = createLogger({ name: "api", level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const store = new DrizzleStore(db);
const masterKey = parseMasterKey(env.FLOWGUARD_MASTER_KEY);

const githubApp = createGithubApp({
  appId: env.GITHUB_APP_ID,
  privateKey: decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY_BASE64),
});

async function resolveSecret(ref: string): Promise<string> {
  const rows = await db.select().from(secrets).where(eq(secrets.id, ref)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`secret not found: ${ref}`);
  return decryptSecret({ ciphertext: row.ciphertext, dekWrapped: row.dekWrapped }, masterKey);
}

const queues = createQueues(env.REDIS_URL, logger);

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});

const inference = createInferenceFromEnv({
  logSink: (e) =>
    logger.info(
      { capability: e.capability, model: e.usage.model, tokens: e.usage.completionTokens },
      "inference call",
    ),
});

const orchestratorDeps: OrchestratorDeps = {
  store,
  githubApp,
  logger: createLogger({ name: "orchestrator", level: env.LOG_LEVEL }),
  resolveSecret,
  makeVercelClient: (token, teamId) => new VercelClient({ token, teamId }),
  enqueueFlowJob: queues.enqueueFlowJob,
  awaitFlowResult: queues.awaitFlowResult,
  removeQueuedJob: queues.removeQueuedJob,
  setAbortKey: queues.setAbortKey,
  artifactLink: artifactLinkBuilder(env.PUBLIC_API_URL, masterKey),
  dashboardUrl: env.PUBLIC_DASHBOARD_URL,
  inference,
};

const getRecordingObject = async (key: string): Promise<Buffer> => {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_RECORDINGS_BUCKET, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
};

const schedulerDeps = {
  ...orchestratorDeps,
  enqueueBaseRun: (runId: string) => queues.enqueueControl({ kind: "base-run", runId }),
};

queues.startOrchestrateWorker(async (job) => {
  switch (job.kind) {
    case "run":
      return orchestrateRun(orchestratorDeps, job.runId);
    case "base-run":
      return orchestrateBaseRun(orchestratorDeps, job.runId);
    case "nightly":
      return nightlyBaseRuns(schedulerDeps);
    case "sweep":
      return void (await sweepStuckRuns(schedulerDeps));
    case "purge":
      return purgeExpired(schedulerDeps);
    case "compile":
      await compileRecording(
        { store, inference, getObject: getRecordingObject, logger: createLogger({ name: "compiler", level: env.LOG_LEVEL }) },
        job.recordingId,
      );
      return;
    case "validate":
      await validateDraft(
        {
          store,
          logger: createLogger({ name: "validator", level: env.LOG_LEVEL }),
          resolveSecret,
          makeVercelClient: (token, teamId) => new VercelClient({ token, teamId }),
          enqueueFlowJob: queues.enqueueFlowJob as (job: unknown, jobId: string) => Promise<void>,
          awaitFlowResult: queues.awaitFlowResult,
        },
        job.versionId,
      );
      return;
  }
});

const app = buildApp({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  logger,
  artifacts: {
    verifySig: (key, sig) => verifyArtifactSig(key, sig, masterKey),
    signKey: (key) => signArtifactKey(key, masterKey),
    presign: (key) =>
      getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: 300 }),
  },
  recordings: {
    putObject: async (key, data, contentType) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_RECORDINGS_BUCKET,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
    },
    getObject: getRecordingObject,
  },
  compiler: {
    enqueueCompile: (recordingId) => queues.enqueueControl({ kind: "compile", recordingId }),
    enqueueValidate: (versionId) => queues.enqueueControl({ kind: "validate", versionId }),
    draftFromDescription: (projectId, name, description) =>
      draftFromDescription({ store, inference }, projectId, name, description),
  },
  storeSecret: async (projectId, kind, plaintext) => {
    const enc = encryptSecret(plaintext, masterKey);
    return store.createSecret({
      projectId,
      kind,
      ciphertext: enc.ciphertext,
      dekWrapped: enc.dekWrapped,
      kmsKeyId: enc.kmsKeyId,
      last4: kind === "password" ? null : plaintext.slice(-4),
    });
  },
  startBaseRun: (projectId, branch) => startBaseRun(schedulerDeps, projectId, branch),
  deps: {
    store,
    githubApp,
    logger,
    enqueueOrchestration: queues.enqueueOrchestration,
    enqueueBaseRun: schedulerDeps.enqueueBaseRun,
    verifyDeploymentProject: async ({ deploymentUrl, vercelProjectId, vercelTeamId, vercelTokenRef }) => {
      try {
        const token = await resolveSecret(vercelTokenRef);
        const client = new VercelClient({ token, teamId: vercelTeamId });
        return await client.deploymentBelongsToProject(deploymentUrl, vercelProjectId);
      } catch (err) {
        logger.warn({ err }, "vercel project verification unavailable — accepting repo match");
        return true;
      }
    },
  },
});

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(async (address) => {
    await queues.registerSchedules().catch((err) => logger.warn({ err }, "schedule registration failed"));
    logger.info({ address }, "flowguard api listening");
  })
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
