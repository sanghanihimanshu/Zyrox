ALTER TABLE "drafts" ALTER COLUMN "content" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "manifests" ALTER COLUMN "content" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "content" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "source" SET DATA TYPE json;