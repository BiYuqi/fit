import "dotenv/config";
import { parseUserInput } from "../src/services/parser";
import { matchFood } from "../src/services/matcher";
import { itemNutrition } from "../src/services/calc";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf.trim()));
  });
}

function fmt(n: number, decimals = 1) {
  return n.toFixed(decimals);
}

async function main() {
  const text = process.argv[2] ?? (await readStdin());
  if (!text) {
    console.error("用法: npx tsx scripts/heartbeat.ts '中午一碗牛肉面加个蛋'");
    process.exit(1);
  }

  console.log(`\n▶ 输入: ${text}\n`);

  const parsed = await parseUserInput(text);

  if (parsed.intent !== "record") {
    console.log(`意图: ${parsed.intent}，非记录类型。`);
    return;
  }

  console.log(`意图: record  餐型: ${parsed.meal_type ?? "未指定"}\n`);

  const COL = { name: 20, g: 6, kcal: 7, p: 7, f: 7, c: 7 };
  const header = [
    "食物名".padEnd(COL.name),
    "克数".padStart(COL.g),
    "热量".padStart(COL.kcal),
    "蛋白质".padStart(COL.p),
    "脂肪".padStart(COL.f),
    "碳水".padStart(COL.c),
    "估算",
  ].join("  ");
  const sep = "-".repeat(header.length);

  console.log(header);
  console.log(sep);

  let totalCal = 0, totalP = 0, totalF = 0, totalC = 0;

  for (const item of parsed.items) {
    const chosenPortion = item.portions.find((p) => p.label === item.chosen_label);
    const weight_g = chosenPortion?.grams ?? item.portions[0].grams;

    const food = await matchFood(item.canonical);
    const n = itemNutrition(food, weight_g);

    totalCal += n.calories;
    totalP += n.protein_g;
    totalF += n.fat_g;
    totalC += n.carbs_g;

    const displayName = food.name.length > COL.name
      ? food.name.slice(0, COL.name - 1) + "…"
      : food.name;

    console.log([
      displayName.padEnd(COL.name),
      fmt(weight_g, 0).padStart(COL.g),
      fmt(n.calories).padStart(COL.kcal),
      fmt(n.protein_g).padStart(COL.p),
      fmt(n.fat_g).padStart(COL.f),
      fmt(n.carbs_g).padStart(COL.c),
      n.incomplete ? "⚠ 不完整" : food.is_estimated ? "≈ 估算" : "",
    ].join("  "));
  }

  console.log(sep);
  console.log([
    "合计".padEnd(COL.name),
    "".padStart(COL.g),
    fmt(totalCal).padStart(COL.kcal),
    fmt(totalP).padStart(COL.p),
    fmt(totalF).padStart(COL.f),
    fmt(totalC).padStart(COL.c),
  ].join("  "));
  console.log();
}

main().catch((err) => {
  console.error("错误:", err.message ?? err);
  process.exit(1);
});
