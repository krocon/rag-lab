ALTER TABLE "collections" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "path" text;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_collection_id_path_unique" ON "documents" USING btree ("collection_id","path") WHERE "documents"."path" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_path_valid" CHECK ("documents"."path" IS NULL OR char_length("documents"."path") BETWEEN 1 AND 512);