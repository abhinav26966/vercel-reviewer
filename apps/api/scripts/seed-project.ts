/**
 * Project setup script (doc 09 Phase 1 task 3 — "no UI yet; seed via script").
 * Creates org + project rows, binds repo ↔ Vercel project, and stores the Vercel
 * token + bypass secret in the encrypted vault.
 *
 * Usage:
 *   pnpm --filter @flowguard/api seed:project -- \
 *     --repo you/flowguard \
 *     --vercel-project prj_xxx \
 *     --vercel-team team_xxx \
 *     --vercel-token <token> \
 *     --bypass-secret <secret> \        (optional)
 *     --base-branches main              (comma-separated, default main)
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { createDb, githubInstallations, orgs, projects, secrets } from "@flowguard/db";
import { encryptSecret, newId, parseMasterKey } from "@flowguard/shared";

const { values: args } = parseArgs({
  options: {
    repo: { type: "string" },
    "vercel-project": { type: "string" },
    "vercel-team": { type: "string" },
    "vercel-token": { type: "string" },
    "bypass-secret": { type: "string" },
    "base-branches": { type: "string", default: "main" },
    name: { type: "string" },
  },
});

if (!args.repo || !args["vercel-project"] || !args["vercel-token"]) {
  console.error("required: --repo owner/repo --vercel-project prj_x --vercel-token <token>");
  process.exit(1);
}

const masterKey = parseMasterKey(
  process.env.FLOWGUARD_MASTER_KEY ??
    (() => {
      throw new Error("FLOWGUARD_MASTER_KEY is required");
    })(),
);
const db = createDb(process.env.DATABASE_URL);

// org (single-founder v1: one org)
const orgId = newId("org");
const existingOrg = await db.select().from(orgs).limit(1);
const org = existingOrg[0] ?? (await db.insert(orgs).values({ id: orgId, name: "founder" }).returning())[0]!;

// installation must exist (arrives via the installation webhook when the app is installed)
const installs = await db.select().from(githubInstallations).limit(2);
if (installs.length === 0) {
  console.error(
    "no github_installations row found — install the GitHub App on the repo first\n" +
      "(with `pnpm dev` + `pnpm dev:webhooks` running so the installation webhook lands)",
  );
  process.exit(1);
}
const installation = installs[0]!;

async function storeSecret(kind: string, plaintext: string): Promise<string> {
  const enc = encryptSecret(plaintext, masterKey);
  const id = newId("secret");
  await db.insert(secrets).values({
    id,
    projectId: null,
    kind,
    ciphertext: enc.ciphertext,
    dekWrapped: enc.dekWrapped,
    kmsKeyId: enc.kmsKeyId,
    last4: plaintext.slice(-4),
  });
  return id;
}

const existing = await db.select().from(projects).where(eq(projects.githubRepo, args.repo)).limit(1);
const tokenRef = await storeSecret("token", args["vercel-token"]);
const bypassRef = args["bypass-secret"] ? await storeSecret("bypass", args["bypass-secret"]) : null;
const baseBranches = args["base-branches"]!.split(",").map((s) => s.trim());

if (existing[0]) {
  await db
    .update(projects)
    .set({
      vercelProjectId: args["vercel-project"],
      vercelTeamId: args["vercel-team"] ?? null,
      vercelTokenRef: tokenRef,
      vercelBypassSecretRef: bypassRef,
      baseBranches,
      githubInstallationId: installation.id,
    })
    .where(eq(projects.id, existing[0].id));
  console.log(`updated project ${existing[0].id} (${args.repo})`);
} else {
  const id = newId("project");
  await db.insert(projects).values({
    id,
    orgId: org.id,
    name: args.name ?? args.repo.split("/")[1]!,
    githubRepo: args.repo,
    githubInstallationId: installation.id,
    vercelProjectId: args["vercel-project"],
    vercelTeamId: args["vercel-team"] ?? null,
    vercelTokenRef: tokenRef,
    vercelBypassSecretRef: bypassRef,
    baseBranches,
  });
  console.log(`created project ${id} (${args.repo}) bound to ${args["vercel-project"]}`);
}
process.exit(0);
