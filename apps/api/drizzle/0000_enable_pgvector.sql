-- RAGLab migration 0000: enable pgvector.
-- Domain tables (collections, documents, chunks) follow in prompts/003-database-domain-model.md.
CREATE EXTENSION IF NOT EXISTS vector;
