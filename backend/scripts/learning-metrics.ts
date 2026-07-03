import "dotenv/config";
import { prisma } from "../src/lib/prisma";

// LEARNING_SPEC §9 基线指标：按用户"注册周龄"分桶，看 |log_ratio| 中位数是否随时间下降。
// 曲线下降 = 学习闭环在生效；用于 T31 上线前后的 A/B 判据。

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const events = await prisma.learningEvent.findMany({
    where: { log_ratio: { not: null } },
    select: { log_ratio: true, created_at: true, user: { select: { created_at: true } } },
  });

  if (events.length === 0) {
    console.log("暂无带 log_ratio 的学习事件（还没有足够的用户反馈）。");
    return;
  }

  const buckets = new Map<number, number[]>();
  for (const e of events) {
    const weekAge = Math.floor(
      (e.created_at.getTime() - e.user.created_at.getTime()) / (7 * 24 * 3600 * 1000),
    );
    const arr = buckets.get(weekAge) ?? [];
    arr.push(Math.abs(e.log_ratio as number));
    buckets.set(weekAge, arr);
  }

  const weeks = [...buckets.keys()].sort((a, b) => a - b);
  console.log("注册周龄\t事件数\t|log_ratio|中位数");
  for (const w of weeks) {
    const vals = buckets.get(w)!;
    console.log(`第${w}周\t${vals.length}\t${median(vals)?.toFixed(3)}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
