CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"status" integer NOT NULL,
	"ok" boolean NOT NULL,
	"attempt" integer NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"events" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_created" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhooks_project" ON "webhooks" USING btree ("project_id");