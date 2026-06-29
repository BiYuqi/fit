-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "ActivityLevel" AS ENUM ('sedentary', 'light', 'moderate', 'active', 'very_active');

-- CreateEnum
CREATE TYPE "GoalType" AS ENUM ('cut', 'maintain');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('breakfast', 'lunch', 'dinner', 'snack');

-- CreateEnum
CREATE TYPE "PortionLabel" AS ENUM ('small', 'medium', 'large', 'custom');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "gender" "Gender",
    "age" INTEGER,
    "height_cm" DECIMAL(65,30),
    "weight_kg" DECIMAL(65,30),
    "target_weight_kg" DECIMAL(65,30),
    "activity_level" "ActivityLevel",
    "goal_type" "GoalType" NOT NULL DEFAULT 'cut',
    "daily_deficit" INTEGER NOT NULL DEFAULT 500,
    "onboarded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodStandard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT NOT NULL,
    "edible_ratio" DOUBLE PRECISION DEFAULT 1,
    "calories_100g" DOUBLE PRECISION,
    "protein_100g" DOUBLE PRECISION,
    "fat_100g" DOUBLE PRECISION,
    "carbs_100g" DOUBLE PRECISION,
    "fiber_100g" DOUBLE PRECISION,
    "is_composite" BOOLEAN NOT NULL DEFAULT false,
    "is_estimated" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'composition_table',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodStandard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodRecord" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "food_id" TEXT NOT NULL,
    "meal_type" "MealType" NOT NULL,
    "portion_label" "PortionLabel" NOT NULL,
    "weight_g" DOUBLE PRECISION NOT NULL,
    "calories" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL,
    "fat" DOUBLE PRECISION NOT NULL,
    "carbs" DOUBLE PRECISION NOT NULL,
    "food_confidence" DOUBLE PRECISION,
    "portion_confidence" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'text',
    "raw_input" TEXT,
    "parse_log_id" TEXT,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExerciseRecord" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "duration_min" INTEGER,
    "calories_burned" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'text',
    "raw_input" TEXT,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExerciseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySummary" (
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "calories_in" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bmr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tdee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "exercise_out" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_out" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deficit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protein" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target_calories" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target_protein" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySummary_pkey" PRIMARY KEY ("user_id","date")
);

-- CreateTable
CREATE TABLE "AiParseLog" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "input_text" TEXT NOT NULL,
    "parsed_json" JSONB,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiParseLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingRecord" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "raw_input" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "role" "ChatRole" NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT,
    "payload" JSONB,
    "record_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_account_key" ON "User"("account");

-- CreateIndex
CREATE INDEX "FoodStandard_name_idx" ON "FoodStandard"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FoodStandard_name_category_key" ON "FoodStandard"("name", "category");

-- CreateIndex
CREATE INDEX "FoodRecord_user_id_date_idx" ON "FoodRecord"("user_id", "date");

-- CreateIndex
CREATE INDEX "ExerciseRecord_user_id_date_idx" ON "ExerciseRecord"("user_id", "date");

-- CreateIndex
CREATE INDEX "ChatMessage_user_id_date_created_at_idx" ON "ChatMessage"("user_id", "date", "created_at");

-- AddForeignKey
ALTER TABLE "FoodRecord" ADD CONSTRAINT "FoodRecord_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodRecord" ADD CONSTRAINT "FoodRecord_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "FoodStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseRecord" ADD CONSTRAINT "ExerciseRecord_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiParseLog" ADD CONSTRAINT "AiParseLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingRecord" ADD CONSTRAINT "PendingRecord_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
