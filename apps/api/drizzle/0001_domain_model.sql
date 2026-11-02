CREATE TYPE "public"."document_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"char_count" integer NOT NULL,
	"token_estimate" integer,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_content_not_blank" CHECK (length(trim("chunks"."content")) > 0),
	CONSTRAINT "chunks_chunk_index_non_negative" CHECK ("chunks"."chunk_index" >= 0),
	CONSTRAINT "chunks_offsets_valid" CHECK ("chunks"."start_offset" >= 0 AND "chunks"."end_offset" >= "chunks"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"embedding_provider" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_name_length" CHECK (char_length("collections"."name") BETWEEN 1 AND 120),
	CONSTRAINT "collections_description_length" CHECK ("collections"."description" IS NULL OR char_length("collections"."description") <= 2000),
	CONSTRAINT "collections_embedding_dimensions_positive" CHECK ("collections"."embedding_dimensions" > 0)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"collection_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"content" text NOT NULL,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_id_chunk_index_unique" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_collection_id_idx" ON "chunks" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "collections_name_lower_unique" ON "collections" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "documents_collection_id_status_idx" ON "documents" USING btree ("collection_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_collection_id_content_sha256_unique" ON "documents" USING btree ("collection_id","content_sha256");