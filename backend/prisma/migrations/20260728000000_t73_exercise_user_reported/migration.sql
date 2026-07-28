-- T73: 运动记录热量是否为用户自报（vs MET 估算）。改时长时据此决定要不要重算热量。
ALTER TABLE "ExerciseRecord" ADD COLUMN "user_reported" BOOLEAN NOT NULL DEFAULT false;
