import "dotenv/config";
import { runImplicitAcceptJob } from "../src/services/learning";

// 每日跑一次（部署平台 cron 调用，见 ARCHITECTURE §6）：
// 入库超 24h、从未产生过 learning_event 的 food_record 视为隐式确认。
async function main() {
  const hours = Number(process.argv[2]) || 24;
  const count = await runImplicitAcceptJob(hours);
  console.log(`隐式确认job：扫到 ${count} 条超 ${hours}h 未处理的记录，已记 implicit_accept 信号。`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
