// T70：清理 modify.ts 变体命名叠加 bug（已在 services/intents/modify.ts 修复）产生的存量脏条目
// （如"葱花饼（无油）（无油）"）。幂等：找不到脏条目时直接退出，可安全重复执行。
//
// 处理顺序（避免留悬空外键）：
// 1. 找到脏条目对应的正确单后缀条目（若不存在则跳过，不猜造）。
// 2. 把 FoodRecord / UserFoodAlias / LearningEvent 里指向脏条目的 food_id 改指向正确条目。
//    UserFoodAlias 里 canonical 字段本身就是脏后缀名的那一条（不会再被任何代码路径查到），直接删除。
// 3. 删除脏 FoodStandard 条目。
import { prisma } from "../src/lib/prisma";

async function main() {
  const dirty = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id, name FROM "FoodStandard" WHERE name ~ '（.*）（'
  `;
  if (dirty.length === 0) {
    console.log("没有找到叠加后缀的脏条目，无需清理。");
    return;
  }

  for (const d of dirty) {
    const canonicalName = d.name.replace(/（([^）]+)）（\1）$/, "（$1）");
    if (canonicalName === d.name) {
      console.log(`⚠️ ${d.name} 不是"同一后缀叠两次"的模式，跳过（需人工判断）`);
      continue;
    }
    const canonical = await prisma.foodStandard.findFirst({ where: { name: canonicalName } });
    if (!canonical) {
      console.log(`⚠️ ${d.name} 没找到对应的正确条目"${canonicalName}"，跳过（不臆造）`);
      continue;
    }

    const [recordCount, aliasesToDelete, aliasUpdateCount, learningCount] = await Promise.all([
      prisma.foodRecord.count({ where: { food_id: d.id } }),
      prisma.userFoodAlias.count({ where: { food_id: d.id, canonical: d.name } }),
      prisma.userFoodAlias.count({ where: { food_id: d.id, canonical: { not: d.name } } }),
      prisma.learningEvent.count({ where: { food_id: d.id } }),
    ]);
    console.log(
      `${d.name} (${d.id}) → ${canonicalName} (${canonical.id})：` +
      `${recordCount} 条 food_record，${aliasesToDelete} 条脏名 alias（删），${aliasUpdateCount} 条正常 alias（改指向），${learningCount} 条 learning_event（改指向）`
    );

    await prisma.$transaction([
      prisma.foodRecord.updateMany({ where: { food_id: d.id }, data: { food_id: canonical.id } }),
      prisma.learningEvent.updateMany({ where: { food_id: d.id }, data: { food_id: canonical.id } }),
      // 脏名本身作为 alias key 永远不会再被任何代码路径查询到（modify.ts 的叠加 bug 已修），直接删
      prisma.userFoodAlias.deleteMany({ where: { food_id: d.id, canonical: d.name } }),
      // 指向脏条目、但 alias key 本身是正常单后缀名的——改指向正确条目
      prisma.userFoodAlias.updateMany({ where: { food_id: d.id, canonical: { not: d.name } }, data: { food_id: canonical.id } }),
      prisma.foodStandard.delete({ where: { id: d.id } }),
    ]);
    console.log(`  ✅ 已清理`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
