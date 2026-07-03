-- AlterTable
ALTER TABLE "FoodRecord" ADD COLUMN     "alias_canonical" TEXT;

-- CreateTable
CREATE TABLE "UserFoodAlias" (
    "user_id" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "food_id" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "streak" INTEGER NOT NULL DEFAULT 1,
    "last_chosen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFoodAlias_pkey" PRIMARY KEY ("user_id","canonical")
);

-- AddForeignKey
ALTER TABLE "UserFoodAlias" ADD CONSTRAINT "UserFoodAlias_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFoodAlias" ADD CONSTRAINT "UserFoodAlias_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "FoodStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
