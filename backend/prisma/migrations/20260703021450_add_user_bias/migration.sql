-- AlterTable
ALTER TABLE "FoodRecord" ADD COLUMN     "predicted_grams" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "UserBias" (
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "mu" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sigma2" DOUBLE PRECISION NOT NULL DEFAULT 0.09,
    "n_eff" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBias_pkey" PRIMARY KEY ("user_id","scope","scope_key")
);

-- CreateTable
CREATE TABLE "BiasUpdateLog" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "mu_before" DOUBLE PRECISION NOT NULL,
    "sigma2_before" DOUBLE PRECISION NOT NULL,
    "n_eff_before" DOUBLE PRECISION NOT NULL,
    "mu_after" DOUBLE PRECISION NOT NULL,
    "sigma2_after" DOUBLE PRECISION NOT NULL,
    "n_eff_after" DOUBLE PRECISION NOT NULL,
    "clamped" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiasUpdateLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BiasUpdateLog_user_id_scope_scope_key_created_at_idx" ON "BiasUpdateLog"("user_id", "scope", "scope_key", "created_at");

-- AddForeignKey
ALTER TABLE "UserBias" ADD CONSTRAINT "UserBias_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiasUpdateLog" ADD CONSTRAINT "BiasUpdateLog_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "LearningEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
