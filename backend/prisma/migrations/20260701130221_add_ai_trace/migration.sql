-- CreateTable
CREATE TABLE "AiTrace" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT,
    "meal_id" TEXT,
    "input_text" TEXT NOT NULL,
    "intent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'started',
    "model_used" TEXT,
    "model_upgraded" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER,
    "token_usage" JSONB,
    "error_info" JSONB,
    "prompt_messages" JSONB,
    "prompt_tools" JSONB,
    "prompt_hash" TEXT,
    "state_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTraceEvent" (
    "id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "item_index" INTEGER,
    "seq" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "state_before" JSONB,
    "state_after" JSONB,
    "input_state" JSONB,
    "output_state" JSONB,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTraceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiTrace_user_id_created_at_idx" ON "AiTrace"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "AiTrace_session_id_idx" ON "AiTrace"("session_id");

-- CreateIndex
CREATE INDEX "AiTrace_user_id_meal_id_idx" ON "AiTrace"("user_id", "meal_id");

-- CreateIndex
CREATE INDEX "AiTrace_prompt_hash_idx" ON "AiTrace"("prompt_hash");

-- CreateIndex
CREATE INDEX "AiTraceEvent_trace_id_item_index_seq_idx" ON "AiTraceEvent"("trace_id", "item_index", "seq");

-- AddForeignKey
ALTER TABLE "AiTrace" ADD CONSTRAINT "AiTrace_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTraceEvent" ADD CONSTRAINT "AiTraceEvent_trace_id_fkey" FOREIGN KEY ("trace_id") REFERENCES "AiTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
