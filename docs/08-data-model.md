# 08 — Platform Data Model (Postgres)

Drizzle schema lives in `packages/db`; this doc is the source of truth. All ids are prefixed nanoids (`prj_`, `flw_`…). All tables get `created_at/updated_at`. JSONB columns are Zod-validated at the boundary.

```sql
-- ═══ Tenancy & integrations ═══════════════════════════════════════════
CREATE TABLE orgs (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE users (id text PRIMARY KEY, org_id text REFERENCES orgs, email text UNIQUE NOT NULL, name text);

CREATE TABLE github_installations (
  id text PRIMARY KEY, org_id text REFERENCES orgs,
  installation_id bigint UNIQUE NOT NULL, account_login text NOT NULL
);

CREATE TABLE projects (
  id text PRIMARY KEY, org_id text REFERENCES orgs, name text NOT NULL,
  github_repo text NOT NULL,                    -- "owner/repo"
  github_installation_id text REFERENCES github_installations,
  vercel_project_id text,                       -- explicit binding (multi-project repos!)
  vercel_team_id text,
  vercel_token_ref text,                        -- secret ref
  vercel_bypass_secret_ref text,                -- secret ref (Protection Bypass for Automation)
  base_branches text[] NOT NULL DEFAULT '{main}',
  settings jsonb NOT NULL DEFAULT '{}'          -- {runnerConcurrency, measureSamples, agentHealEnabled,
                                                --  perfDefaults{relativeFactor,absoluteFloorMs},
                                                --  fanoutGlobs[], authPathGlobs[], artifactRetentionDays,
                                                --  rootDir (Vercel Root Directory, maps coverage paths → repo paths)}
);

-- ═══ Secrets (envelope-encrypted) ═════════════════════════════════════
CREATE TABLE secrets (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  kind text NOT NULL,                           -- password|username|card|token|bypass
  ciphertext bytea NOT NULL, dek_wrapped bytea NOT NULL, kms_key_id text NOT NULL,
  last4 text                                    -- display hint only
);

-- ═══ Credentials & payment config (scoped) ════════════════════════════
CREATE TABLE credential_sets (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  scope text NOT NULL,                          -- 'project' | 'pr'
  pr_number int,                                -- set when scope='pr'; CHECK enforced
  persona text NOT NULL,                        -- 'default','admin','premium_user',...
  username_secret_id text REFERENCES secrets,
  password_secret_id text REFERENCES secrets,
  data_branch_differs boolean NOT NULL DEFAULT false,  -- user-flag; also inferred when scope='pr'
  expires_at timestamptz,                       -- pr-scoped: auto-set on PR close/merge
  UNIQUE (project_id, scope, pr_number, persona)
);

CREATE TABLE payment_configs (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  scope text NOT NULL, pr_number int,           -- same scoping as credentials
  provider text NOT NULL,                       -- 'stripe' | 'paypal_sandbox' | 'razorpay_test'
  card_secret_id text REFERENCES secrets,
  expiry text, cvc_secret_id text REFERENCES secrets,
  extras jsonb NOT NULL DEFAULT '{}',           -- coupon codes, expected price ids, quirks
  consent_confirmed_at timestamptz NOT NULL,    -- the explicit opt-in gate
  test_card_recognized boolean NOT NULL,        -- soft-validation result at save time
  UNIQUE (project_id, scope, pr_number, provider)
);

-- ═══ Flows & versions ═════════════════════════════════════════════════
CREATE TABLE flows (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  name text NOT NULL, tier text NOT NULL DEFAULT 'standard',   -- 'smoke'|'standard'
  persona text, serial_group text,
  archived boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, name)
);

CREATE TABLE flow_spec_versions (
  id text PRIMARY KEY, flow_id text REFERENCES flows,
  spec jsonb NOT NULL,                          -- the Flow Spec (doc 02), immutable
  status text NOT NULL,                         -- 'draft'|'official'|'pending'|'quarantined'|'archived'
  branch text NOT NULL,                         -- baseline branch this version belongs to
  source text NOT NULL,                         -- 'recording'|'plain_language'|'baseline_promotion'|'heal_patch'
  source_recording_id text,
  approved_by text REFERENCES users,            -- for 'pending' (the 🔵 approve click)
  approved_from_run_id text,                    -- head run whose behavior was accepted
  supersedes_version_id text REFERENCES flow_spec_versions,
  compilation_report jsonb
);
CREATE UNIQUE INDEX one_official_per_flow_branch ON flow_spec_versions (flow_id, branch)
  WHERE status IN ('official','quarantined');   -- quarantined = official-but-red-on-base

CREATE TABLE recordings (
  id text PRIMARY KEY, project_id text REFERENCES projects, flow_id text,
  flow_name text,                               -- user-chosen name captured at record time
  trace_key text NOT NULL,                      -- s3 key of raw bundle
  origin text, status text NOT NULL             -- 'uploaded'|'compiling'|'compiled'|'failed'
);

-- ═══ Coverage & perf baselines ════════════════════════════════════════
CREATE TABLE coverage_maps (
  id text PRIMARY KEY, flow_id text REFERENCES flows,
  branch text NOT NULL, sha text NOT NULL,
  files text[] NOT NULL, api_routes text[] NOT NULL,
  UNIQUE (flow_id, branch, sha)
);
-- selection query: latest row per (flow, branch)

CREATE TABLE perf_baselines (
  id text PRIMARY KEY, flow_id text REFERENCES flows,
  branch text NOT NULL, sha text NOT NULL, step_key text NOT NULL,
  median_ms int NOT NULL, samples int NOT NULL,
  UNIQUE (flow_id, branch, sha, step_key)
);

-- ═══ Deployments, PRs, runs ═══════════════════════════════════════════
CREATE TABLE deployments (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  vercel_deployment_id text UNIQUE, sha text NOT NULL, branch text,
  url text NOT NULL, environment text NOT NULL, state text NOT NULL
);

CREATE TABLE pull_requests (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  number int NOT NULL, title text, body text, author text,
  head_branch text, base_branch text NOT NULL,
  state text NOT NULL, sticky_comment_id bigint,   -- for in-place comment edits
  UNIQUE (project_id, number)
);

CREATE TABLE runs (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  kind text NOT NULL,                           -- 'pr' | 'base' | 'nightly' | 'validation'
  pr_id text REFERENCES pull_requests,
  head_sha text, head_deployment_id text REFERENCES deployments,
  merge_base_sha text, base_deployment_id text REFERENCES deployments,
  branch text,                                  -- for base/nightly runs
  state text NOT NULL,                          -- state machine (doc 06 §3)
  plan jsonb,                                   -- selected flows + selection reasons + cache decisions
  superseded_by text REFERENCES runs,
  started_at timestamptz, finished_at timestamptz,
  UNIQUE (project_id, head_sha, head_deployment_id, kind)   -- idempotency
);

CREATE TABLE run_flow_results (
  id text PRIMARY KEY, run_id text REFERENCES runs,
  flow_id text REFERENCES flows, spec_version_id text REFERENCES flow_spec_versions,
  target text NOT NULL,                         -- 'head'|'base'
  status text NOT NULL, failure_class text, failed_step_id text,
  result jsonb NOT NULL,                        -- full RunFlowResult (doc 02 §5)
  artifacts jsonb NOT NULL,                     -- s3 keys
  from_cache boolean NOT NULL DEFAULT false,
  UNIQUE (run_id, flow_id, target)
);
-- base result cache = query run_flow_results by (spec_version_id, base sha via run) — or maintain:
CREATE TABLE base_result_cache (
  spec_version_id text REFERENCES flow_spec_versions,
  base_sha text NOT NULL, result_id text REFERENCES run_flow_results,
  PRIMARY KEY (spec_version_id, base_sha)
);

CREATE TABLE verdicts (
  id text PRIMARY KEY, run_id text REFERENCES runs, flow_id text REFERENCES flows,
  verdict text NOT NULL,                        -- taxonomy (doc 05 §1)
  confidence real, rationale text, human_copy text NOT NULL,
  evidence jsonb NOT NULL,                      -- keys of the judge evidence bundle
  approval_state text,                          -- for 🔵: 'awaiting'|'approved'|'rejected'
  approved_by text REFERENCES users, pending_version_id text REFERENCES flow_spec_versions
);

CREATE TABLE session_states (                   -- storageState cache
  persona text NOT NULL, deployment_id text REFERENCES deployments,
  s3_key text NOT NULL, PRIMARY KEY (persona, deployment_id)
);

CREATE TABLE webhook_deliveries (           -- idempotency ledger (doc 01 §6): insert-first,
  id text PRIMARY KEY,                      -- X-GitHub-Delivery GUID; conflict ⇒ already processed
  event text NOT NULL, action text
);

CREATE TABLE alerts (
  id text PRIMARY KEY, project_id text REFERENCES projects,
  kind text NOT NULL,                           -- 'base_broken'|'baseline_conflict'|'stuck_run'|...
  payload jsonb NOT NULL, acknowledged_at timestamptz
);
```

## Notes & invariants

- **Immutability:** `flow_spec_versions.spec` and `run_flow_results.result` never update in place; corrections create new rows.
- **Quarantine flip:** base run red → official version status → `quarantined`; next green base run flips back to `official`. The partial unique index treats both as "the current version."
- **Promotion:** base run finds a `pending` version whose behavior matches → new version row `status='official', source='baseline_promotion', supersedes_version_id=<old official>`; old official → `archived`; pending → `archived`.
- **PR-scoped cleanup:** on `pull_request.closed` → set `expires_at=now()` on matching credential_sets/payment_configs; nightly purge deletes expired rows + their secrets.
- **Retention:** artifacts referenced by `run_flow_results.artifacts` purged per project setting (default 30d; failure bundles 90d); rows keep metadata.
- **Indexes to add during implementation:** runs by (project, state), run_flow_results by (spec_version_id), deployments by (project, sha), verdicts by (run_id).
