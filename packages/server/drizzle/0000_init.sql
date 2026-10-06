CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"document_id" text PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"ttl" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"document_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"variants" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "functions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manifest_traffic" (
	"environment_id" text NOT NULL,
	"hash" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "manifest_traffic_environment_id_hash_day_pk" PRIMARY KEY("environment_id","hash","day")
);
--> statement-breakpoint
CREATE TABLE "manifests" (
	"project_id" text NOT NULL,
	"hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifests_project_id_hash_pk" PRIMARY KEY("project_id","hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"preview_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"document_id" text NOT NULL,
	"default_version_id" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"environment_id" text NOT NULL,
	"day" text NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"node_id" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "telemetry_environment_id_day_type_subject_ref_kind_node_id_pk" PRIMARY KEY("environment_id","day","type","subject","ref","kind","node_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"number" integer NOT NULL,
	"ref" text NOT NULL,
	"content" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "functions" ADD CONSTRAINT "functions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_traffic" ADD CONSTRAINT "manifest_traffic_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_default_version_id_versions_id_fk" FOREIGN KEY ("default_version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_project_created" ON "audit_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_project_key" ON "documents" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_key" ON "environments" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_project_key" ON "experiments" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "functions_project_name" ON "functions" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_env_document" ON "releases" USING btree ("environment_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_document_number" ON "versions" USING btree ("document_id","number");--> statement-breakpoint
CREATE INDEX "versions_ref" ON "versions" USING btree ("ref");