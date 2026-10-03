CREATE TABLE "agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"title" text NOT NULL,
	"participant_id" text,
	"scope" jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "agent_conversations_tenant_agent_idx" ON "agent_conversations" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_tenant_participant_idx" ON "agent_conversations" USING btree ("tenant_id","participant_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_open_recent_idx" ON "agent_conversations" USING btree ("tenant_id","last_message_at" DESC NULLS LAST) WHERE "agent_conversations"."closed_at" IS NULL;