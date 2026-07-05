import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { FlowSpec, ProjectSettings, RunFlowResult } from "@flowguard/schemas";

/**
 * Platform data model — source of truth: docs/08-data-model.md. Keep in lockstep.
 * All ids are prefixed nanoids; all tables get created_at/updated_at; JSONB is
 * Zod-validated at the boundary (this package stores, @flowguard/schemas validates).
 */

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ═══ Tenancy & integrations ═══════════════════════════════════════════

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => orgs.id),
  email: text("email").unique().notNull(),
  name: text("name"),
  ...timestamps,
});

export const githubInstallations = pgTable("github_installations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => orgs.id),
  installationId: bigint("installation_id", { mode: "number" }).unique().notNull(),
  accountLogin: text("account_login").notNull(),
  ...timestamps,
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => orgs.id),
  name: text("name").notNull(),
  /** "owner/repo" */
  githubRepo: text("github_repo").notNull(),
  githubInstallationId: text("github_installation_id").references(() => githubInstallations.id),
  /** Explicit binding — one repo can back multiple Vercel projects, never guess (doc 06 §1). */
  vercelProjectId: text("vercel_project_id"),
  vercelTeamId: text("vercel_team_id"),
  vercelTokenRef: text("vercel_token_ref"),
  vercelBypassSecretRef: text("vercel_bypass_secret_ref"),
  baseBranches: text("base_branches")
    .array()
    .notNull()
    .default(sql`'{main}'`),
  settings: jsonb("settings").$type<Partial<ProjectSettings>>().notNull().default({}),
  ...timestamps,
});

// ═══ Secrets (envelope-encrypted) ═════════════════════════════════════

export const secrets = pgTable("secrets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id),
  /** password|username|card|token|bypass */
  kind: text("kind").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  dekWrapped: bytea("dek_wrapped").notNull(),
  kmsKeyId: text("kms_key_id").notNull(),
  /** display hint only */
  last4: text("last4"),
  ...timestamps,
});

// ═══ Credentials & payment config (scoped) ════════════════════════════

export const credentialSets = pgTable(
  "credential_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    /** 'project' | 'pr' */
    scope: text("scope").notNull(),
    prNumber: integer("pr_number"),
    persona: text("persona").notNull(),
    usernameSecretId: text("username_secret_id").references(() => secrets.id),
    passwordSecretId: text("password_secret_id").references(() => secrets.id),
    /** user-flag; also inferred when scope='pr' (doc 07 §3). */
    dataBranchDiffers: boolean("data_branch_differs").notNull().default(false),
    /** pr-scoped: auto-set on PR close/merge. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("credential_sets_scope_unique").on(t.projectId, t.scope, t.prNumber, t.persona),
    check("credential_sets_pr_scope_check", sql`(${t.scope} = 'pr') = (${t.prNumber} IS NOT NULL)`),
  ],
);

export const paymentConfigs = pgTable(
  "payment_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    scope: text("scope").notNull(),
    prNumber: integer("pr_number"),
    /** 'stripe' | 'paypal_sandbox' | 'razorpay_test' */
    provider: text("provider").notNull(),
    cardSecretId: text("card_secret_id").references(() => secrets.id),
    expiry: text("expiry"),
    cvcSecretId: text("cvc_secret_id").references(() => secrets.id),
    /** coupon codes, expected price ids, quirks */
    extras: jsonb("extras").$type<Record<string, unknown>>().notNull().default({}),
    /** the explicit opt-in gate (doc 07 §6). */
    consentConfirmedAt: timestamp("consent_confirmed_at", { withTimezone: true }).notNull(),
    /** soft-validation result at save time. */
    testCardRecognized: boolean("test_card_recognized").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payment_configs_scope_unique").on(t.projectId, t.scope, t.prNumber, t.provider),
    check("payment_configs_pr_scope_check", sql`(${t.scope} = 'pr') = (${t.prNumber} IS NOT NULL)`),
  ],
);

// ═══ Flows & versions ═════════════════════════════════════════════════

export const flows = pgTable(
  "flows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    /** 'smoke' | 'standard' */
    tier: text("tier").notNull().default("standard"),
    persona: text("persona"),
    serialGroup: text("serial_group"),
    archived: boolean("archived").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("flows_project_name_unique").on(t.projectId, t.name)],
);

export const flowSpecVersions = pgTable(
  "flow_spec_versions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").references(() => flows.id),
    /** the Flow Spec (doc 02), immutable */
    spec: jsonb("spec").$type<FlowSpec>().notNull(),
    /** 'draft'|'official'|'pending'|'quarantined'|'archived' */
    status: text("status").notNull(),
    /** baseline branch this version belongs to */
    branch: text("branch").notNull(),
    /** 'recording'|'plain_language'|'baseline_promotion'|'heal_patch' */
    source: text("source").notNull(),
    sourceRecordingId: text("source_recording_id"),
    /** for 'pending' (the 🔵 approve click) */
    approvedBy: text("approved_by").references(() => users.id),
    /** head run whose behavior was accepted */
    approvedFromRunId: text("approved_from_run_id"),
    supersedesVersionId: text("supersedes_version_id"),
    compilationReport: jsonb("compilation_report").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    // quarantined = official-but-red-on-base; both count as "the current version"
    uniqueIndex("one_official_per_flow_branch")
      .on(t.flowId, t.branch)
      .where(sql`${t.status} IN ('official','quarantined')`),
  ],
);

export const recordings = pgTable("recordings", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id),
  flowId: text("flow_id"),
  /** s3 key of raw bundle */
  traceKey: text("trace_key").notNull(),
  origin: text("origin"),
  /** 'uploaded'|'compiling'|'compiled'|'failed' */
  status: text("status").notNull(),
  ...timestamps,
});

// ═══ Coverage & perf baselines ════════════════════════════════════════

export const coverageMaps = pgTable(
  "coverage_maps",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").references(() => flows.id),
    branch: text("branch").notNull(),
    sha: text("sha").notNull(),
    files: text("files").array().notNull(),
    apiRoutes: text("api_routes").array().notNull(),
    ...timestamps,
  },
  // selection query: latest row per (flow, branch)
  (t) => [uniqueIndex("coverage_maps_flow_branch_sha_unique").on(t.flowId, t.branch, t.sha)],
);

export const perfBaselines = pgTable(
  "perf_baselines",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").references(() => flows.id),
    branch: text("branch").notNull(),
    sha: text("sha").notNull(),
    stepKey: text("step_key").notNull(),
    medianMs: integer("median_ms").notNull(),
    samples: integer("samples").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("perf_baselines_flow_branch_sha_step_unique").on(t.flowId, t.branch, t.sha, t.stepKey),
  ],
);

// ═══ Deployments, PRs, runs ═══════════════════════════════════════════

export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    vercelDeploymentId: text("vercel_deployment_id").unique(),
    sha: text("sha").notNull(),
    branch: text("branch"),
    url: text("url").notNull(),
    environment: text("environment").notNull(),
    state: text("state").notNull(),
    ...timestamps,
  },
  (t) => [index("deployments_project_sha_idx").on(t.projectId, t.sha)],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title"),
    body: text("body"),
    author: text("author"),
    headBranch: text("head_branch"),
    baseBranch: text("base_branch").notNull(),
    state: text("state").notNull(),
    /** for in-place sticky comment edits (doc 05 §6). */
    stickyCommentId: bigint("sticky_comment_id", { mode: "number" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("pull_requests_project_number_unique").on(t.projectId, t.number)],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    /** 'pr' | 'base' | 'nightly' | 'validation' */
    kind: text("kind").notNull(),
    prId: text("pr_id").references(() => pullRequests.id),
    headSha: text("head_sha"),
    headDeploymentId: text("head_deployment_id").references(() => deployments.id),
    mergeBaseSha: text("merge_base_sha"),
    baseDeploymentId: text("base_deployment_id").references(() => deployments.id),
    /** for base/nightly runs */
    branch: text("branch"),
    /** state machine (doc 06 §3) */
    state: text("state").notNull(),
    /** selected flows + selection reasons + cache decisions */
    plan: jsonb("plan").$type<Record<string, unknown>>(),
    supersededBy: text("superseded_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // idempotency (doc 01 §6)
    uniqueIndex("runs_idempotency_unique").on(t.projectId, t.headSha, t.headDeploymentId, t.kind),
    index("runs_project_state_idx").on(t.projectId, t.state),
  ],
);

export const runFlowResults = pgTable(
  "run_flow_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => runs.id),
    flowId: text("flow_id").references(() => flows.id),
    specVersionId: text("spec_version_id").references(() => flowSpecVersions.id),
    /** 'head' | 'base' */
    target: text("target").notNull(),
    status: text("status").notNull(),
    failureClass: text("failure_class"),
    failedStepId: text("failed_step_id"),
    /** full RunFlowResult (doc 02 §5), immutable */
    result: jsonb("result").$type<RunFlowResult>().notNull(),
    /** s3 keys */
    artifacts: jsonb("artifacts").$type<Record<string, string | null>>().notNull(),
    fromCache: boolean("from_cache").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("run_flow_results_run_flow_target_unique").on(t.runId, t.flowId, t.target),
    index("run_flow_results_spec_version_idx").on(t.specVersionId),
  ],
);

export const baseResultCache = pgTable(
  "base_result_cache",
  {
    specVersionId: text("spec_version_id").references(() => flowSpecVersions.id),
    baseSha: text("base_sha").notNull(),
    resultId: text("result_id").references(() => runFlowResults.id),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.specVersionId, t.baseSha] })],
);

export const verdicts = pgTable(
  "verdicts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => runs.id),
    flowId: text("flow_id").references(() => flows.id),
    /** taxonomy (doc 05 §1) */
    verdict: text("verdict").notNull(),
    confidence: real("confidence"),
    rationale: text("rationale"),
    humanCopy: text("human_copy").notNull(),
    /** keys of the judge evidence bundle */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    /** for 🔵: 'awaiting'|'approved'|'rejected' */
    approvalState: text("approval_state"),
    approvedBy: text("approved_by").references(() => users.id),
    pendingVersionId: text("pending_version_id").references(() => flowSpecVersions.id),
    ...timestamps,
  },
  (t) => [index("verdicts_run_idx").on(t.runId)],
);

/** storageState cache (doc 07 §5). */
export const sessionStates = pgTable(
  "session_states",
  {
    persona: text("persona").notNull(),
    deploymentId: text("deployment_id").references(() => deployments.id),
    s3Key: text("s3_key").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.persona, t.deploymentId] })],
);

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id),
  /** 'base_broken'|'baseline_conflict'|'stuck_run'|... */
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  ...timestamps,
});
