CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdict_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"verdict_id" text,
	"project_id" text,
	"run_id" text,
	"flow_id" text,
	"reported_verdict" text NOT NULL,
	"reason" text,
	"reported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_reports" ADD CONSTRAINT "verdict_reports_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_reports" ADD CONSTRAINT "verdict_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_reports" ADD CONSTRAINT "verdict_reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_reports" ADD CONSTRAINT "verdict_reports_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_project_idx" ON "usage_events" USING btree ("project_id","created_at");