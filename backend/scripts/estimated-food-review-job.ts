import "dotenv/config";
import { runEstimatedFoodReviewJob, REVIEW_MIN_REFS } from "../src/services/food-review";

// 周期跑（周级即可，部署平台 cron 调用，可与隐式确认 job 同宿）：
// is_estimated=true、被 food_record 引用 ≥ minRefs 且未复核过的条目，
// 用 deepseek-v4-pro 带聚合上下文重估营养，过护栏才更新（见 T33 / FOOD_DB_SPEC §3）。
async function main() {
  const minRefs = Number(process.argv[2]) || REVIEW_MIN_REFS;
  const r = await runEstimatedFoodReviewJob(minRefs);
  console.log(
    `估算食物复核job：扫到 ${r.scanned} 条引用≥${minRefs}的待复核条目，` +
      `更新 ${r.updated}，拒绝 ${r.rejected}（留待人工复核），失败 ${r.failed}（下次重试）。`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
