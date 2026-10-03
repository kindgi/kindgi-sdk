CREATE TABLE "agent_run_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_message" text NOT NULL,
	"participant_id" text,
	"dry_run" integer DEFAULT 0 NOT NULL,
	"principal" jsonb,
	"authz" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_run_snapshots_tenant_idx" ON "agent_run_snapshots" USING btree ("tenant_id");