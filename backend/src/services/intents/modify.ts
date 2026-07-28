import { prisma } from "../../lib/prisma";
import { matchFood, matchFoodExactOrEstimate } from "../matcher";
import { itemNutrition, scaleNutritionToCalories } from "../calc";
import { recompute, buildContextCard } from "../summary";
import { recordModifyCorrection } from "../trace";
import { recordLearningEvent, resetFoodAliasStreak, upsertFoodAlias } from "../learning";
import { processItems } from "./food-item";
import { calcExerciseCalories } from "./exercise";
import { refreshMealCard } from "../meal-card";
import { executeDelete } from "../delete-record";
import { guessMealType, toDateOnly, extractDateOffsetFromText, addOffsetDays, dateOnlyStr } from "../../lib/dates";
import type { MealType, PortionLabel } from "@prisma/client";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

const MEAL_ZH: Record<string, string> = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };

// 用户话里带餐次/位置限定词时，说明 target 是被明确指定的，别再做"默认取最近"纠偏。
const QUALIFIER_RE =
  /早餐|早饭|早上|早晨|中午|午餐|午饭|晌午|晚餐|晚饭|晚上|傍晚|夜宵|夜里|加餐|下午|上午|刚才|刚刚|那个|那条|那碗|那盘|那份|那杯|第[一二三四12345]|上面|下面|前面|后面|最后/;

const stripParen = (s: string) => s.replace(/[（(][^）)]*[)）]/g, "");

// 最长公共子串（判两条记录是不是"同名/近义"，如"炒瘦肉"vs"排骨瘦肉"共有"瘦肉"）
function longestCommonSubstr(a: string, b: string): string {
  let best = "";
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j <= a.length; j++) {
      const sub = a.slice(i, j);
      if (sub.length > best.length && b.includes(sub)) best = sub;
    }
  }
  return best;
}

// 同名多条消歧兜底（2026-07-05 真机翻车，AItrace 实锤）：同一天早/晚各记过一次"瘦肉"，
// 用户说"瘦肉改为50克"（没指餐次），模型 0.95 高置信却挑了列表靠前的【早餐】那条改错。
// LLM 消歧不可靠（换措辞/换展示序仍选错），这里做确定性纠偏：用户没给餐次/位置限定词、
// 且提到的名字在今日记录里撞到多条时，改成最近记的那条（＝用户正在操作、刚记的那条）。
// 只对 update/delete 单条食物生效；带限定词一律信任模型输出。
export function disambiguateRecent(
  ref: string,
  action: string,
  text: string,
  records: { ref: string; kind: string; name: string }[],
): string {
  if (action !== "update" && action !== "delete") return ref;
  if (QUALIFIER_RE.test(text)) return ref;
  const chosen = records.find((r) => r.ref === ref);
  if (!chosen || chosen.kind !== "food") return ref;
  const chosenCore = stripParen(chosen.name);
  const sameNamed = records.filter((r) => {
    if (r.kind !== "food") return false;
    if (r.ref === chosen.ref) return true;
    const core = longestCommonSubstr(chosenCore, stripParen(r.name));
    return core.length >= 2 && text.includes(core); // 共有名字片段且用户确实提到了它
  });
  if (sameNamed.length <= 1) return ref;
  // records 按 created_at 旧→新，最后一条即最近记录
  return sameNamed[sameNamed.length - 1].ref;
}

export async function handleModify(
  parsed: Extract<ParseResult, { intent: "modify" }>,
  ctx: IntentCtx,
) {
  const { user_id, text, source, today, dateObj, pack, messages, tctx, parseUsage, parseMessages } = ctx;

  // target 可为 ref 数组（批量改餐次"以上发的都是早餐"）；其余场景等价单条
  const refs = Array.isArray(parsed.target) ? parsed.target : [parsed.target];

  // ── 批量改餐次：多 target + update + change.meal_type → 一次改完，汇总一条回复 ──
  // （schema/prompt 约定数组只用于批量改餐次；其他批量组合不受支持，走下方单条逻辑取第一条）
  if (refs.length > 1 && parsed.action === "update" && parsed.change?.meal_type) {
    const newMeal = parsed.change.meal_type as MealType;
    const foodRefs = refs
      .map((ref) => pack.recent_records.find((r) => r.ref === ref))
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === "food");
    const recs = await prisma.foodRecord.findMany({
      where: { id: { in: foodRefs.map((r) => r.record_id) }, user_id },
      include: { food: true },
    });
    if (recs.length === 0) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "没找到要改餐次的那些记录，可以说得具体一点吗？" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }

    await prisma.foodRecord.updateMany({
      where: { id: { in: recs.map((r) => r.id) }, user_id },
      data: { meal_type: newMeal },
    });
    await recompute(user_id, today);
    for (const rec of recs) {
      await recordModifyCorrection({
        traceId: tctx.traceId,
        recordId: rec.id,
        foodId: rec.food_id,
        foodName: rec.food.name,
        prevState: { meal_type: rec.meal_type },
        newState: { meal_type: newMeal },
        isFoodChange: false,
        modifyConfidence: (parsed as any).modify_confidence,
      });
    }
    const card = await buildContextCard(user_id);
    const content = `已把 ${recs.length} 条记录改为${MEAL_ZH[newMeal]}：${recs.map((r) => r.food.name).join("、")}。`;
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content },
    });
    messages.push(aiMsg);

    // T47 双卡刷新：旧餐次卡少一项（只 bump 已存在的，不给 pre-T46 的餐凭空造卡）、新餐次卡多一项。
    // 按 (餐归属日, 餐次) 去重；旧卡先 bump、新卡后 bump，新卡浮到最末。批量改无单条撤销，不动 last_changes。
    const oldKeys = new Map<string, { mealDate: string; meal_type: MealType }>();
    const newKeys = new Map<string, { mealDate: string; meal_type: MealType }>();
    for (const rec of recs) {
      const mealDate = rec.date.toISOString().slice(0, 10);
      if (rec.meal_type !== newMeal) {
        oldKeys.set(`${mealDate}|${rec.meal_type}`, { mealDate, meal_type: rec.meal_type as MealType });
      }
      newKeys.set(`${mealDate}|${newMeal}`, { mealDate, meal_type: newMeal });
    }
    for (const k of oldKeys.values()) {
      await refreshMealCard(messages, {
        user_id, mealDate: k.mealDate, meal_type: k.meal_type,
        chatDate: toDateOnly(k.mealDate), createIfMissing: false,
      });
    }
    for (const k of newKeys.values()) {
      await refreshMealCard(messages, {
        user_id, mealDate: k.mealDate, meal_type: k.meal_type,
        chatDate: toDateOnly(k.mealDate),
      });
    }

    tctx.ok("modify", { mealType: newMeal, tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: content, summary_card: card, messages };
  }

  // ── 缺陷2 护栏（T53）：target 数组但不是批量改餐次（每样改不同值这种）──
  // 数组只能配一个 change，表达不了"A改X、B改Y"，模型本应走 multi（每样一个 modify op）。
  // 绝不静默取 refs[0] 只改第一条、其余无声吞掉（会算错数据且无法恢复）——不动数据，让失败可见。
  if (refs.length > 1) {
    const aiMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "text",
        content: "一次改多样、每样数值不同的话，我这么一起改容易改错。麻烦分别说一下，比如「玉米改成180克」「瘦肉改成50克」。",
      },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
  }

  // 同名多条消歧兜底（见上）：模型选早了就纠到最近那条；带餐次/位置限定词则信任模型。
  const resolvedRef = disambiguateRecent(refs[0], parsed.action, text, pack.recent_records);
  const target = pack.recent_records.find((r) => r.ref === resolvedRef);
  if (!target) {
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "没找到要修改的那条记录，可以说得具体一点吗？" },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages }); // trace 结束：status=partial（找不到 target）
    return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
  }

  // delete → 免确认直删 + 可撤销事件行（T49：不再走 pending 确认卡）
  if (parsed.action === "delete") {
    const result = await executeDelete({
      user_id,
      kind: target.kind === "exercise" ? "exercise" : "food",
      record_id: target.record_id,
      skipLog: true, // chat.ts 已为本轮统一写 ai_parse_log + 回填 reply_summary
    });
    if (!result.ok) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条记录好像已经不在了。" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }
    const content = `已删除 ${result.name} · -${result.calories} kcal`;
    const eventMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "event",
        payload: {
          event_type: "deleted", text: content, record_id: target.record_id,
          undo: { prev_state: result.snapshot }, undone: false,
        } as object,
      },
    });
    messages.push(eventMsg);
    // 卡片跟随：事件行先落，受影响餐卡（少一项）后 bump 浮到最末；只 bump 已存在的卡
    if (result.mealInfo) {
      await refreshMealCard(messages, {
        user_id, mealDate: result.mealInfo.mealDate, meal_type: result.mealInfo.meal_type,
        chatDate: dateObj, createIfMissing: false,
      });
    }
    tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: content, summary_card: result.summary_card, messages };
  }

  // append → 在 target 所属餐追加新食物（继承 meal_type），高置信直入库 + 撤销
  if (parsed.action === "append") {
    const meal_type = (target.meal_type ?? guessMealType()) as MealType;
    await tctx.setMeal(meal_type); // trace: 关联 meal + 写入 state_snapshot

    // target 只能来自 pack.recent_records（今日 L1 快照），所以被追加的那餐必然是今天的（T62 不变式）
    const { records, replyParts, pending, needsRecompute, pendingCreateFns } =
      await processItems(
        parsed.items ?? [],
        { user_id, meal_type, source, dateObj, recordDate: dateObj },
        (idx) => tctx.itemTrace(idx),
      );

    for (const fn of pendingCreateFns) messages.push(await fn());
    if (needsRecompute) await recompute(user_id, today);

    // T47：追加并入该餐 meal_card 并 bump；无 prev_state = 撤销即删除（同 append undo 语义）。
    // T53：撤销态按 record_id set 进 last_changes 数组，不覆盖同卡其他记录的撤销态。
    if (records.length > 0) {
      await refreshMealCard(messages, {
        user_id, mealDate: today, meal_type, chatDate: dateObj,
        lastChange: { op: "set", change: { record_id: records[records.length - 1].id } },
      });
    }
    const card = await buildContextCard(user_id);
    let reply: string;
    if (records.length > 0) {
      reply = `已追加：${replyParts.join("，")}。`;
    } else if (pending) {
      reply = "请帮我确认追加内容。";
    } else {
      reply = "没听清要加什么，能再说一遍吗？比如「加200ml纯奶」";
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: reply },
      });
      messages.push(aiMsg);
    }
    tctx.ok("modify", { mealType: meal_type, tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply, records: records.length ? records : undefined, pending: pending ?? undefined, summary_card: card, messages };
  }

  // update → 改份量 / 改食物 / 改运动消耗，高置信直改 + 重算 + 撤销

  // ── 运动记录更新（T73：时长 / 消耗两个维度，用户说哪个改哪个）──
  if (target.kind === "exercise") {
    const exRec = await prisma.exerciseRecord.findFirst({ where: { id: target.record_id, user_id } });
    if (!exRec) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条运动记录好像已经不在了。" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages }); // trace 结束：记录已不存在
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }

    const change = parsed.change ?? {};
    // 两个维度都没给才追问（改前只认 calories_burned，用户说"是15分钟"时无处安放，连问两遍走进死循环）
    if (change.duration_min == null && change.calories_burned == null) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "要改时长还是消耗？比如「改成 15 分钟」或「改成 400 千卡」。" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      // 追问是正常的澄清轮次不是失败：意图识别成功、只是信息不全 → ok 而非 fail/partial
      tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }

    const prev_calories = exRec.calories_burned;
    const prev_duration = exRec.duration_min;
    const prev_user_reported = exRec.user_reported;
    const newDuration = change.duration_min ?? prev_duration;

    // 热量取值三条路：用户直接报数 > 用户自报值沿用（不被 MET 覆盖）> 按新时长 MET 重算。
    // 体重用 user.weight_kg（同 record.ts），不读 weight_log 最新值——改时长不该顺带改变热量基准。
    let newCalories = prev_calories;
    let newUserReported = prev_user_reported;
    let caloriesRecalced = false;
    if (change.calories_burned != null) {
      newCalories = Math.round(change.calories_burned);
      newUserReported = true; // 用户真值（同 T50 record 侧口径）
    } else if (!prev_user_reported && newDuration != null) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: user_id } });
      newCalories = calcExerciseCalories(exRec.type, newDuration, Number(user.weight_kg) || 70);
      caloriesRecalced = true;
    }

    const updated = await prisma.exerciseRecord.update({
      where: { id: exRec.id },
      data: { duration_min: newDuration, calories_burned: newCalories, user_reported: newUserReported },
    });
    await recompute(user_id, today);
    const card = await buildContextCard(user_id);

    // 回执按实际改了什么说，别谎称重算：热量沿用用户自报值时要说明白
    const durStr = (d: number | null) => (d != null ? `${d}分钟` : "");
    const parts: string[] = [];
    if (newDuration !== prev_duration) parts.push(`${durStr(prev_duration)} → ${durStr(newDuration)}`);
    if (Math.round(newCalories) !== Math.round(prev_calories)) {
      parts.push(`消耗${caloriesRecalced ? "约 " : " "}${Math.round(newCalories)} kcal（原 ${Math.round(prev_calories)} kcal）`);
    } else if (newUserReported && change.duration_min != null) {
      parts.push(`消耗仍按你报的 ${Math.round(newCalories)} kcal`);
    }
    // 模型偶尔回传与原值相同的数字（"改成30分钟"但本来就是30分钟）——此时别说"已更新"再跟个空尾巴
    const content = parts.length > 0
      ? `已更新：${exRec.type} ${parts.join(" · ")}`
      : `${exRec.type} 本来就是 ${durStr(newDuration)} · ${Math.round(newCalories)} kcal，没有变化`;
    const aiMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "exercise_card", content,
        payload: {
          exercise_id: updated.id, type: exRec.type, duration_min: newDuration,
          calories_burned: newCalories, user_reported: newUserReported,
          undo: {
            record_id: updated.id,
            // 快照要含全部被改字段，否则撤销只回滚一半（改前只存 calories_burned，时长回不去）
            prev_state: {
              kind: "exercise" as const, calories_burned: prev_calories,
              duration_min: prev_duration ?? undefined, user_reported: prev_user_reported,
            },
          },
        } as object,
        record_id: updated.id as string,
      },
    });
    messages.push(aiMsg);
    tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: content, summary_card: card, messages };
  }

  // ── 食物记录更新 ──
  const rec = await prisma.foodRecord.findFirst({ where: { id: target.record_id, user_id } });
  if (!rec) {
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条记录好像已经不在了。" },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages }); // trace 结束：记录已不存在
    return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
  }

  const prev_state = {
    food_id: rec.food_id, portion_label: rec.portion_label, weight_g: rec.weight_g, meal_type: rec.meal_type,
    calories: rec.calories, protein: rec.protein, fat: rec.fat, carbs: rec.carbs, calories_source: rec.calories_source,
    date: rec.date.toISOString().slice(0, 10),
  };
  const change = parsed.change ?? {};

  // T62：改日期（"是昨天的晚餐，不是今天的"）。文本里的相对日期词优先于 AI 的 change.date_offset，
  // 同 record 侧的确定性覆盖模式。target 只能来自今日 L1 快照，rec.date 此刻必然是 today，
  // 偏移相对 dateObj（今天）算即可。dateChanged 要求算出来的新日期真的和原日期不同——
  // AI 偶尔即使没有日期词也会顺手填 date_offset:0（"改回今天"的字面默认值），
  // 若不加这层比较，会对本来就没变过日期的记录误触发"改到 X 日"的回执文案和多余 recompute。
  const dateOffsetResolved = extractDateOffsetFromText(text) ?? change.date_offset;
  const candidateDateObj = dateOffsetResolved !== undefined ? addOffsetDays(dateObj, dateOffsetResolved) : rec.date;
  const dateChanged = dateOnlyStr(candidateDateObj) !== dateOnlyStr(rec.date);
  const newDateObj = dateChanged ? candidateDateObj : rec.date;
  const newMealDateStr = dateChanged ? dateOnlyStr(newDateObj) : rec.date.toISOString().slice(0, 10);
  let food = await prisma.foodStandard.findUniqueOrThrow({ where: { id: rec.food_id } });
  const originalFoodName = food.name; // T40 自愈闭环：属性修正后 alias 指回这个原名（下次同名食物直连命中修正版）
  let weight_g = rec.weight_g;
  let portion_label = rec.portion_label as PortionLabel;
  let meal_type = rec.meal_type as MealType;

  if (change.food) {
    food = await matchFood(change.food, undefined, user_id);   // 改食物：份量沿用旧的
  }
  if (change.food_desc) {
    // T40：属性修正（"无油"/"去皮"等）影响营养口径——构造具体变体名强制重估，不走弱匹配裁决
    // （否则 trgm 几乎必然召回原条目，复用旧营养值会让修正静默失效，见 matchFoodExactOrEstimate 注释）
    // T70：food.name 若已带同样后缀（同一属性改第二次）不再叠加，否则产生"葱花饼（无油）（无油）"这种脏名。
    const suffix = `（${change.food_desc}）`;
    const targetName = food.name.endsWith(suffix) ? food.name : `${food.name}${suffix}`;
    food = await matchFoodExactOrEstimate(targetName, text, user_id);
  }
  if (change.meal_type) {
    meal_type = change.meal_type as MealType;                  // 改餐次（"粽子是中午吃的"）：数值不动
  }
  if (change.portion_label) {
    portion_label = change.portion_label as PortionLabel;
    if (change.grams) weight_g = change.grams;
  } else if (change.grams) {
    weight_g = change.grams;
    portion_label = "custom";
  }

  // 学习信号（LEARNING_SPEC §7）：改食物覆盖了用户食物直连自动匹配的结果 → 清零该 alias 的 streak，
  // 且这条记录不再代表"按习惯匹配"，清掉标记（同「不是它？」逃生口，只是触发方式是 modify 而非按钮）
  if (change.food && rec.alias_canonical) {
    resetFoodAliasStreak(user_id, rec.alias_canonical);
  }
  // T40 自愈闭环（LEARNING_SPEC §6 §7）：属性修正产生的估算条目直连回原食物名，
  // 下次再说"葱花饼"，streak≥2 后直接命中无油版——修正一次终身受益。
  if (change.food_desc) {
    upsertFoodAlias(user_id, originalFoodName, food.id);
  }

  const baseNutrition = itemNutrition(food, weight_g);
  // T40：change.calories 是用户亲口给出的最终热量（用户真值），铁律 1 禁的是 AI 算账，不禁用户报数——
  // 直接采信，按比例回推宏量素；calories_source=user_override 防止后续同条记录被 food×grams 静默重算覆盖。
  let nutrition = change.calories != null ? scaleNutritionToCalories(baseNutrition, change.calories) : baseNutrition;
  const calories_source = change.calories != null ? "user_override" : "computed";

  // T64：用户直接指定的单项宏量素克数（用户真值）——只改用户点名的那个字段，热量不动，
  // calories_source 不受影响（用户纠正的是蛋白质/脂肪/碳水，不是热量，不该被标记成热量的 user_override）。
  // 未点名的字段要保留"当前值"而非重算基准：食物/重量本轮没变时，rec.protein/fat/carbs 里
  // 可能已经叠加过上一轮的用户修正，itemNutrition 重算会把它静默冲掉（用户这次没提就不该被动）。
  if (change.protein != null || change.fat != null || change.carbs != null) {
    const foodOrWeightChanged = !!change.food || !!change.food_desc || change.grams != null || !!change.portion_label;
    const macroBase = foodOrWeightChanged
      ? nutrition
      : { protein_g: rec.protein, fat_g: rec.fat, carbs_g: rec.carbs };
    nutrition = {
      ...nutrition,
      protein_g: change.protein ?? macroBase.protein_g,
      fat_g: change.fat ?? macroBase.fat_g,
      carbs_g: change.carbs ?? macroBase.carbs_g,
    };
  }

  const updated = await prisma.foodRecord.update({
    where: { id: rec.id },
    data: {
      food_id: food.id, portion_label, weight_g, meal_type,
      calories: nutrition.calories, protein: nutrition.protein_g,
      fat: nutrition.fat_g, carbs: nutrition.carbs_g,
      calories_source,
      calories_computed: calories_source === "user_override" ? baseNutrition.calories : null, // T66：偏差三元组一角
      alias_canonical: (change.food || change.food_desc) ? null : undefined,
      ...(dateChanged ? { date: newDateObj } : {}),
    },
  });
  await recompute(user_id, today);
  if (dateChanged) await recompute(user_id, newMealDateStr); // 日期变了，新旧两天的 daily_summary 都要更新
  const card = await buildContextCard(user_id);

  // T49：回执降级为居中事件行（带 delta），撤销走 meal_card 项级 last_changes，事件行本身不带 undo
  const oldCal = Math.round(prev_state.calories);
  const newCal = Math.round(nutrition.calories);
  const delta = newCal - oldCal;
  const deltaStr = delta !== 0 ? `（${delta > 0 ? "+" : ""}${delta} kcal）` : "";
  let subject: string;
  if (dateChanged) {
    // 日期变化必须在回执文案里明确带出（T62 教训：本次事故四次纠正全静默失败，用户完全看不到系统反应）
    subject = `${food.name} 改到 ${newMealDateStr}${change.meal_type ? `${MEAL_ZH[meal_type]}` : ""}`;
  } else if (change.food || change.food_desc) {
    subject = `${originalFoodName} → ${food.name}`;
  } else if (change.grams != null || change.portion_label) {
    subject = `${food.name} ${Math.round(prev_state.weight_g)}g → ${Math.round(weight_g)}g`;
  } else if (change.meal_type) {
    subject = `${food.name} 改到${MEAL_ZH[meal_type]}`;
  } else if (change.calories != null) {
    subject = `${food.name} 热量改为 ${newCal}kcal`;
  } else if (change.protein != null || change.fat != null || change.carbs != null) {
    const macroParts: string[] = [];
    if (change.protein != null) macroParts.push(`蛋白质 ${Math.round(prev_state.protein)}g → ${Math.round(nutrition.protein_g)}g`);
    if (change.fat != null) macroParts.push(`脂肪 ${Math.round(prev_state.fat)}g → ${Math.round(nutrition.fat_g)}g`);
    if (change.carbs != null) macroParts.push(`碳水 ${Math.round(prev_state.carbs)}g → ${Math.round(nutrition.carbs_g)}g`);
    subject = `${food.name} ${macroParts.join("，")}`;
  } else {
    subject = food.name;
  }
  const content = `已修改：${subject}${deltaStr}`;
  const aiMsg = await prisma.chatMessage.create({
    data: {
      user_id, date: dateObj, role: "assistant", kind: "event",
      payload: { event_type: "modified", text: content, record_id: updated.id, undone: false } as object,
    },
  });
  messages.push(aiMsg);

  // 修改走原地刷新该餐 meal_card。改餐次或改日期都是双卡刷新：
  // 旧卡少一项（只 bump 已存在的），新卡多一项；撤销信息写进目标餐卡 last_changes（按 record_id）
  // （单槽：再次修改覆盖，撤销后由 undo 接口清除）。
  const mealDate = rec.date.toISOString().slice(0, 10); // 改前所在日（=today，L1 不变式）
  if (meal_type !== prev_state.meal_type || dateChanged) {
    await refreshMealCard(messages, {
      user_id, mealDate, meal_type: prev_state.meal_type as MealType,
      chatDate: toDateOnly(mealDate), createIfMissing: false,
    });
  }
  await refreshMealCard(messages, {
    user_id, mealDate: newMealDateStr, meal_type, chatDate: dateObj,
    // T53：撤销=还原 prev_state，按 record_id set 进 last_changes（批量改时各条互不覆盖）
    lastChange: { op: "set", change: { record_id: updated.id, prev_state } },
  });
  // 学习信号（LEARNING_SPEC §3）：predicted = 改前克数，final = 用户指定克数。
  // 只有 change.grams 时才是"克数纠正"——改食物（change.food）份量沿用旧的，不算纠正。
  if (change.grams != null) {
    recordLearningEvent({
      user_id,
      food_record_id: updated.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: prev_state.weight_g,
      final_grams: weight_g,
      predicted_label: prev_state.portion_label,
      final_label: portion_label,
      signal_type: "explicit_gram",
      scene: rec.scene,
    });
  }
  // 学习信号（T40）：热量/属性修正只记档不训练克数偏差模型（predicted==final_grams，权重0）
  if (change.calories != null) {
    recordLearningEvent({
      user_id,
      food_record_id: updated.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: weight_g,
      final_grams: weight_g,
      predicted_label: portion_label,
      final_label: portion_label,
      signal_type: "calorie_override",
      scene: rec.scene,
    });
  }
  if (change.food_desc != null) {
    recordLearningEvent({
      user_id,
      food_record_id: updated.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: weight_g,
      final_grams: weight_g,
      predicted_label: portion_label,
      final_label: portion_label,
      signal_type: "food_desc_correction",
      scene: rec.scene,
    });
  }
  // Trace: correction event（modify update——用户主动修改了 AI 的记录）
  await recordModifyCorrection({
    traceId: tctx.traceId,
    recordId: rec.id,
    foodId: rec.food_id,
    foodName: food.name,
    prevState: prev_state,
    newState: { food_name: food.name, food_id: food.id, portion_label, weight_g, calories: Math.round(nutrition.calories), calories_source },
    isFoodChange: !!(change.food || change.food_desc),
    modifyConfidence: (parsed as any).modify_confidence,
  });
  tctx.ok("modify", { tokenUsage: parseUsage });
  return { intent: "modify", reply: content, record: updated, summary_card: card, messages };
}
