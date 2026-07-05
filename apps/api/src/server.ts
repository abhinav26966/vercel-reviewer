import { createDb, secrets } from "@flowguard/db";
import { eq } from "drizzle-orm";
import { createGithubApp, decodePrivateKey } from "@flowguard/github";
import { createLogger, decryptSecret, parseMasterKey } from "@flowguard/shared";
import { VercelClient } from "@flowguard/vercel";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
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

const app = buildApp({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  logger,
  deps: {
    store,
    githubApp,
    logger,
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
  .then((address) => logger.info({ address }, "flowguard api listening"))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
