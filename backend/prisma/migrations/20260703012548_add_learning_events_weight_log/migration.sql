-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "food_record_id" TEXT,
    "food_id" TEXT,
    "category" TEXT,
    "scene" TEXT,
    "predicted_grams" DOUBLE PRECISION NOT NULL,
    "applied_grams" DOUBLE PRECISION NOT NULL,
    "final_grams" DOUBLE PRECISION NOT NULL,
    "predicted_label" TEXT,
    "final_label" TEXT,
    "signal_type" TEXT NOT NULL,
    "signal_weight" DOUBLE PRECISION NOT NULL,
    "log_ratio" DOUBLE PRECISION,
    "parse_log_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightLog" (
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "weight_kg" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeightLog_pkey" PRIMARY KEY ("user_id","date")
);

-- CreateIndex
CREATE INDEX "LearningEvent_user_id_food_id_created_at_idx" ON "LearningEvent"("user_id", "food_id", "created_at");

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_food_record_id_fkey" FOREIGN KEY ("food_record_id") REFERENCES "FoodRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "FoodStandard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightLog" ADD CONSTRAINT "WeightLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
