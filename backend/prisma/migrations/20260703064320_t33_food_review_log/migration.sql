-- CreateTable
CREATE TABLE "FoodReviewLog" (
    "id" TEXT NOT NULL,
    "food_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "old_values" JSONB NOT NULL,
    "new_values" JSONB NOT NULL,
    "category_mean" DOUBLE PRECISION,
    "ref_count" INTEGER NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'deepseek-v4-pro',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodReviewLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FoodReviewLog_food_id_idx" ON "FoodReviewLog"("food_id");

-- AddForeignKey
ALTER TABLE "FoodReviewLog" ADD CONSTRAINT "FoodReviewLog_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "FoodStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
