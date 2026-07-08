import { eq } from "drizzle-orm";
import { createDb, projects, secrets } from "@flowguard/db";
import { decryptSecret, parseMasterKey } from "@flowguard/shared";
import { VercelClient } from "@flowguard/vercel";

const db = createDb(process.env.DATABASE_URL);
const masterKey = parseMasterKey(process.env.FLOWGUARD_MASTER_KEY!);
const [project] = await db.select().from(projects).limit(1);
const [tokenRow] = await db.select().from(secrets).where(eq(secrets.id, project!.vercelTokenRef!));
const token = decryptSecret({ ciphertext: tokenRow!.ciphertext, dekWrapped: tokenRow!.dekWrapped }, masterKey);
const client = new VercelClient({ token, teamId: project!.vercelTeamId });
const deployments = await client.listDeployments({ projectId: project!.vercelProjectId!, limit: 3 });
console.log("token OK — recent deployments for bound project:");
for (const d of deployments) console.log(`  ${d.state} ${d.target ?? "preview"} ${d.url}`);
const belongs = await client.deploymentBelongsToProject(deployments[0]!.url, project!.vercelProjectId!);
console.log("deploymentBelongsToProject check:", belongs);
process.exit(0);
