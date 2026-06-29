/**
 * 食物营养库种子导入脚本
 * 数据源: github.com/Sanotsu/china-food-composition-data
 *   → 用 json_data_vision_251206_Qwen2-5-VL-72B-Instruct 文件夹（1677 条，已剔除婴幼儿食品）
 *
 * 用法:
 *   1) git clone https://github.com/Sanotsu/china-food-composition-data
 *   2) 指定 DATA_DIR 为上面那个 vision 文件夹路径
 *   3) 先 dry-run 看清洗 + 自检结果:  ts-node seed_food_standard.ts --dry
 *      复核 review_flags.csv 后再正式入库:  ts-node seed_food_standard.ts
 *
 * 设计要点:
 *   - 数值是 OCR/视觉模型识别，不保证 100% 准确 → 必须跑能量自检挑出异常项人工复核
 *   - "Tr"(微量)/空字符串 → null
 *   - 复合菜/别名/份量不在本源覆盖范围，由 DeepSeek 解析层兜底（见设计文档第 5 节）
 */

import * as fs from "fs";
import * as path from "path";
// import { PrismaClient } from "@prisma/client";  // 正式入库时打开
// const prisma = new PrismaClient();

const DATA_DIR =
  process.env.DATA_DIR ??
  "./china-food-composition-data/json_data_vision_251206_Qwen2-5-VL-72B-Instruct";
const DRY_RUN = process.argv.includes("--dry");

/** 源 JSON 单条结构（只列我们用到的字段） */
interface RawFood {
  foodCode?: string;
  foodName: string;
  edible?: string;        // 食部，百分比数字字符串，如 "63"
  energyKCal?: string;
  protein?: string;
  fat?: string;
  CHO?: string;           // 碳水
  dietaryFiber?: string;
  cholesterol?: string;
  Na?: string;
}

/** 目标 food_standard 行 */
interface FoodStandardSeed {
  name: string;
  category: string;
  edible_ratio: number | null;
  calories_100g: number | null;
  protein_100g: number | null;
  fat_100g: number | null;
  carbs_100g: number | null;
  fiber_100g: number | null;
  aliases: string[];
  is_composite: boolean;
  is_estimated: boolean;
  source: string;
}

/** "Tr" / "" / 非数字 → null；正常 → number */
function parseNum(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === "" || /^tr$/i.test(s) || s === "—" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 从文件名提类目: merged-禽肉类及其制品-鸡.json → "禽肉类及其制品" */
function categoryFromFile(file: string): string {
  const base = file.replace(/^merged-/, "").replace(/\.json$/, "");
  return base.split("-")[0] ?? "未分类";
}

/** 清洗食物名: 去掉 "(代表值)" 等括注尾巴，保留主名 */
function cleanName(name: string): string {
  return name.replace(/[（(].*?[)）]\s*$/g, "").trim() || name.trim();
}

/**
 * 能量自检（Atwater 近似）: 4*蛋白 + 4*碳水 + 9*脂肪
 * 与标注 energyKCal 偏差 > 25% 的挑出来人工复核（不阻断导入）。
 */
function energyCheck(row: FoodStandardSeed): { ok: boolean; predicted: number | null; diffPct: number | null } {
  const { protein_100g: p, carbs_100g: c, fat_100g: f, calories_100g: e } = row;
  if (p == null || c == null || f == null || e == null || e <= 0) {
    return { ok: true, predicted: null, diffPct: null }; // 缺值不判，单独标 null
  }
  const predicted = 4 * p + 4 * c + 9 * f;
  const diffPct = Math.abs(predicted - e) / e;
  return { ok: diffPct <= 0.25, predicted, diffPct };
}

function loadAll(): { rows: FoodStandardSeed[]; flags: string[][] } {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const rows: FoodStandardSeed[] = [];
  const flags: string[][] = [["name", "category", "energyKCal", "predicted", "diffPct", "reason"]];
  const seen = new Set<string>();

  for (const file of files) {
    const category = categoryFromFile(file);
    const raw: RawFood[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8"));

    for (const r of raw) {
      const name = cleanName(r.foodName);
      if (!name) continue;

      const edibleRaw = parseNum(r.edible);
      const row: FoodStandardSeed = {
        name,
        category,
        edible_ratio: edibleRaw == null ? null : +(edibleRaw / 100).toFixed(3),
        calories_100g: parseNum(r.energyKCal),
        protein_100g: parseNum(r.protein),
        fat_100g: parseNum(r.fat),
        carbs_100g: parseNum(r.CHO),
        fiber_100g: parseNum(r.dietaryFiber),
        aliases: [],
        is_composite: false,
        is_estimated: false,
        source: "composition_table",
      };

      // 去重（同名同类目只留一条；可改成按 foodCode）
      const key = `${row.name}__${row.category}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // 自检
      const chk = energyCheck(row);
      if (row.calories_100g == null) {
        flags.push([row.name, row.category, "", "", "", "缺能量值"]);
      } else if (!chk.ok) {
        flags.push([
          row.name,
          row.category,
          String(row.calories_100g),
          chk.predicted!.toFixed(0),
          (chk.diffPct! * 100).toFixed(1) + "%",
          "能量与三大营养素不符，疑似识别错误",
        ]);
      }

      rows.push(row);
    }
  }
  return { rows, flags };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`找不到数据目录: ${DATA_DIR}\n请先 git clone 仓库并设置 DATA_DIR。`);
    process.exit(1);
  }

  const { rows, flags } = loadAll();
  console.log(`解析完成: ${rows.length} 条食物`);
  console.log(`需人工复核: ${flags.length - 1} 条（含缺能量值 / 能量自检异常）`);

  // 输出复核清单
  fs.writeFileSync(
    "review_flags.csv",
    flags.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n"),
    "utf-8"
  );
  console.log("复核清单已写入 review_flags.csv");

  // 输出清洗后的标准种子（可直接给前端/其他用途）
  fs.writeFileSync("food_standard.seed.json", JSON.stringify(rows, null, 2), "utf-8");
  console.log("标准种子已写入 food_standard.seed.json");

  if (DRY_RUN) {
    console.log("dry-run 模式，未写数据库。复核 review_flags.csv 后去掉 --dry 正式入库。");
    return;
  }

  // ===== 正式入库（打开 Prisma 相关注释后启用）=====
  // let ok = 0;
  // for (const row of rows) {
  //   await prisma.foodStandard.upsert({
  //     where: { name_category: { name: row.name, category: row.category } }, // 需在 schema 建复合唯一键
  //     update: row,
  //     create: row,
  //   });
  //   ok++;
  // }
  // console.log(`入库完成: ${ok} 条`);
  // await prisma.$disconnect();
  console.log("（正式入库逻辑已写好但默认注释，接好 Prisma schema 后取消注释即可）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
