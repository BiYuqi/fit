-- T66: 食物记录 user_override 时的偏差三元组一角（系统本会算出的值），可空、不回填存量记录
ALTER TABLE "FoodRecord" ADD COLUMN "calories_computed" DOUBLE PRECISION;
