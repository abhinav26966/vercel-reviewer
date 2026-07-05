CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_result_cache" (
	"spec_version_id" text,
	"base_sha" text NOT NULL,
	"result_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_result_cache_spec_version_id_base_sha_pk" PRIMARY KEY("spec_version_id","base_sha")
);
--> statement-breakpoint
CREATE TABLE "coverage_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text,
	"branch" text NOT NULL,
	"sha" text NOT NULL,
	"files" text[] NOT NULL,
	"api_routes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"scope" text NOT NULL,
	"pr_number" integer,
	"persona" text NOT NULL,
	"username_secret_id" text,
	"password_secret_id" text,
	"data_branch_differs" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_sets_pr_scope_check" CHECK (("credential_sets"."scope" = 'pr') = ("credential_sets"."pr_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"vercel_deployment_id" text,
	"sha" text NOT NULL,
	"branch" text,
	"url" text NOT NULL,
	"environment" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_vercel_deployment_id_unique" UNIQUE("vercel_deployment_id")
);
--> statement-breakpoint
CREATE TABLE "flow_spec_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text,
	"spec" jsonb NOT NULL,
	"status" text NOT NULL,
	"branch" text NOT NULL,
	"source" text NOT NULL,
	"source_recording_id" text,
	"approved_by" text,
	"approved_from_run_id" text,
	"supersedes_version_id" text,
	"compilation_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"persona" text,
	"serial_group" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"scope" text NOT NULL,
	"pr_number" integer,
	"provider" text NOT NULL,
	"card_secret_id" text,
	"expiry" text,
	"cvc_secret_id" text,
	"extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_confirmed_at" timestamp with time zone NOT NULL,
	"test_card_recognized" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_configs_pr_scope_check" CHECK (("payment_configs"."scope" = 'pr') = ("payment_configs"."pr_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "perf_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text,
	"branch" text NOT NULL,
	"sha" text NOT NULL,
	"step_key" text NOT NULL,
	"median_ms" integer NOT NULL,
	"samples" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"github_repo" text NOT NULL,
	"github_installation_id" text,
	"vercel_project_id" text,
	"vercel_team_id" text,
	"vercel_token_ref" text,
	"vercel_bypass_secret_ref" text,
	"base_branches" text[] DEFAULT '{main}' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"number" integer NOT NULL,
	"title" text,
	"body" text,
	"author" text,
	"head_branch" text,
	"base_branch" text NOT NULL,
	"state" text NOT NULL,
	"sticky_comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"flow_id" text,
	"trace_key" text NOT NULL,
	"origin" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_flow_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"flow_id" text,
	"spec_version_id" text,
	"target" text NOT NULL,
	"status" text NOT NULL,
	"failure_class" text,
	"failed_step_id" text,
	"result" jsonb NOT NULL,
	"artifacts" jsonb NOT NULL,
	"from_cache" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"pr_id" text,
	"head_sha" text,
	"head_deployment_id" text,
	"merge_base_sha" text,
	"base_deployment_id" text,
	"branch" text,
	"state" text NOT NULL,
	"plan" jsonb,
	"superseded_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"kms_key_id" text NOT NULL,
	"last4" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_states" (
	"persona" text NOT NULL,
	"deployment_id" text,
	"s3_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_states_persona_deployment_id_pk" PRIMARY KEY("persona","deployment_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"flow_id" text,
	"verdict" text NOT NULL,
	"confidence" real,
	"rationale" text,
	"human_copy" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"approval_state" text,
	"approved_by" text,
	"pending_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_result_cache" ADD CONSTRAINT "base_result_cache_spec_version_id_flow_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."flow_spec_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_result_cache" ADD CONSTRAINT "base_result_cache_result_id_run_flow_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."run_flow_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_maps" ADD CONSTRAINT "coverage_maps_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_sets" ADD CONSTRAINT "credential_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_sets" ADD CONSTRAINT "credential_sets_username_secret_id_secrets_id_fk" FOREIGN KEY ("username_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_sets" ADD CONSTRAINT "credential_sets_password_secret_id_secrets_id_fk" FOREIGN KEY ("password_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_spec_versions" ADD CONSTRAINT "flow_spec_versions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_spec_versions" ADD CONSTRAINT "flow_spec_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_configs" ADD CONSTRAINT "payment_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_configs" ADD CONSTRAINT "payment_configs_card_secret_id_secrets_id_fk" FOREIGN KEY ("card_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_configs" ADD CONSTRAINT "payment_configs_cvc_secret_id_secrets_id_fk" FOREIGN KEY ("cvc_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perf_baselines" ADD CONSTRAINT "perf_baselines_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_flow_results" ADD CONSTRAINT "run_flow_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_flow_results" ADD CONSTRAINT "run_flow_results_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_flow_results" ADD CONSTRAINT "run_flow_results_spec_version_id_flow_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."flow_spec_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_head_deployment_id_deployments_id_fk" FOREIGN KEY ("head_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_base_deployment_id_deployments_id_fk" FOREIGN KEY ("base_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_states" ADD CONSTRAINT "session_states_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_pending_version_id_flow_spec_versions_id_fk" FOREIGN KEY ("pending_version_id") REFERENCES "public"."flow_spec_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coverage_maps_flow_branch_sha_unique" ON "coverage_maps" USING btree ("flow_id","branch","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_sets_scope_unique" ON "credential_sets" USING btree ("project_id","scope","pr_number","persona");--> statement-breakpoint
CREATE INDEX "deployments_project_sha_idx" ON "deployments" USING btree ("project_id","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "one_official_per_flow_branch" ON "flow_spec_versions" USING btree ("flow_id","branch") WHERE "flow_spec_versions"."status" IN ('official','quarantined');--> statement-breakpoint
CREATE UNIQUE INDEX "flows_project_name_unique" ON "flows" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_configs_scope_unique" ON "payment_configs" USING btree ("project_id","scope","pr_number","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "perf_baselines_flow_branch_sha_step_unique" ON "perf_baselines" USING btree ("flow_id","branch","sha","step_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_project_number_unique" ON "pull_requests" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "run_flow_results_run_flow_target_unique" ON "run_flow_results" USING btree ("run_id","flow_id","target");--> statement-breakpoint
CREATE INDEX "run_flow_results_spec_version_idx" ON "run_flow_results" USING btree ("spec_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_unique" ON "runs" USING btree ("project_id","head_sha","head_deployment_id","kind");--> statement-breakpoint
CREATE INDEX "runs_project_state_idx" ON "runs" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "verdicts_run_idx" ON "verdicts" USING btree ("run_id");