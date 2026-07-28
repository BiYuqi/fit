// T73：扫出 duration_min 与 calories_burned 互相矛盾的运动记录——modify.ts 的运动分支
// 改前只 update({calories_burned})、不动时长，走过"改运动消耗"的记录必然留下这种不一致
// （真机 e122ddb1：羽毛球 duration_min=30 但 calories_burned=97.5，实为 15 分钟的量）。
//
// 只读不写：打印出来人工判断。用户自报热量（user_reported=true）本来就不该等于 MET 估算值，
// 直接跳过——那不是脏数据，是用户真值。
//
// ⚠️ 判读 T73 之前的存量记录时注意：user_reported 是 T73 才加的列，迁移把所有存量行填成了 false，
// 所以"记录时用户就自报了热量"的老记录会混在结果里（看 raw_input 有没有提消耗/卡数即可区分）。
// 那类不是矛盾，本任务已按 raw_input 回填 user_reported=true。
import { prisma } from "../src/lib/prisma";
import { calcExerciseCalories } from "../src/services/intents/exercise";

const TOLERANCE = 0.2; // 偏差超过 20% 才报，MET 表本身是粗估，小偏差没有意义

async function main() {
  const records = await prisma.exerciseRecord.findMany({
    where: { user_reported: false, duration_min: { not: null } },
    orderBy: { created_at: "asc" },
  });

  const users = new Map<string, number>();
  for (const u of await prisma.user.findMany({ select: { id: true, weight_kg: true } })) {
    users.set(u.id, Number(u.weight_kg) || 70);
  }

  let found = 0;
  for (const r of records) {
    const expected = calcExerciseCalories(r.type, r.duration_min!, users.get(r.user_id) ?? 70);
    if (expected === 0) continue;
    const deviation = Math.abs(r.calories_burned - expected) / expected;
    if (deviation <= TOLERANCE) continue;
    found++;
    // 按落库热量反推用户当初想说的时长，方便人工核对（MET 与热量成正比，直接按比例回推）
    const impliedDuration = Math.round((r.duration_min! * r.calories_burned) / expected);
    console.log(
      `${r.id.slice(0, 8)} ${r.date.toISOString().slice(0, 10)} ${r.type}：` +
      `落库 ${r.duration_min}min / ${r.calories_burned}kcal，` +
      `按 ${r.duration_min}min 应为 ${expected}kcal（偏差 ${(deviation * 100).toFixed(0)}%），` +
      `热量反推时长 ≈ ${impliedDuration}min`,
    );
  }

  console.log(
    found === 0
      ? `扫描 ${records.length} 条 MET 估算记录，没有发现时长/热量矛盾。`
      : `\n共 ${found} / ${records.length} 条矛盾。本脚本不自动改——确认用户真实意图后手工 UPDATE。`,
  );
}

main().finally(() => prisma.$disconnect());
