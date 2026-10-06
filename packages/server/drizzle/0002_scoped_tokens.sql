ALTER TABLE "api_tokens" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;