-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "UserMemory" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "llm_confidence" DOUBLE PRECISION NOT NULL,
    "importance_class" TEXT NOT NULL DEFAULT 'normal',
    "repetition_count" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'WEAK',
    "source_type" TEXT NOT NULL DEFAULT 'explicit_user',
    "expires_at" TIMESTAMP(3),
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "embedding" vector(1024),
    "source_message_id" TEXT,
    "source_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserMemory_type_check" CHECK ("type" IN ('constraint', 'preference', 'habit', 'context_state', 'goal')),
    CONSTRAINT "UserMemory_importance_class_check" CHECK ("importance_class" IN ('medical', 'strong', 'normal', 'casual')),
    CONSTRAINT "UserMemory_state_check" CHECK ("state" IN ('ACTIVE', 'WEAK', 'ARCHIVED'))
);

-- CreateIndex
CREATE INDEX "UserMemory_user_id_state_idx" ON "UserMemory"("user_id", "state");

-- CreateIndex
CREATE INDEX "UserMemory_user_id_last_accessed_at_idx" ON "UserMemory"("user_id", "last_accessed_at");

-- CreateIndex
CREATE UNIQUE INDEX "UserMemory_user_id_type_entity_content_key" ON "UserMemory"("user_id", "type", "entity", "content");

-- HNSW index for semantic similarity search (preference/habit embedding recall, MEMORY_SPEC §7.1)
CREATE INDEX "UserMemory_embedding_idx" ON "UserMemory"
  USING hnsw ("embedding" vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
