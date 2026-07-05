import { test } from "node:test";
import assert from "node:assert/strict";
import { disambiguateRecent } from "./modify";

// 同名多条消歧兜底（2026-07-05 真机翻车）：早/晚各记过一次"瘦肉"，
// 模型改单样偶发选中较早的早餐那条；无餐次限定词时确定性纠到最近那条。
const recs = [
  { ref: "r1", kind: "food", name: "炒瘦肉（猪肉）" }, // 早餐，较早
  { ref: "r2", kind: "food", name: "猪瘦肉（炒）" }, // 晚餐，最近
];

test("模型选了较早的同名条(r1)、用户没指餐次 → 纠到最近的 r2", () => {
  assert.equal(disambiguateRecent("r1", "update", "瘦肉改为60克", recs), "r2");
});

test("模型已选最近条(r2) → 不动", () => {
  assert.equal(disambiguateRecent("r2", "update", "瘦肉改为60克", recs), "r2");
});

test("用户指明了餐次(早餐) → 信任模型输出，不纠偏", () => {
  assert.equal(disambiguateRecent("r1", "update", "早餐的瘦肉改为50克", recs), "r1");
});

test("用户用位置词(刚才/那个)限定 → 信任模型", () => {
  assert.equal(disambiguateRecent("r1", "update", "刚才那个瘦肉改成50克", recs), "r1");
});

test("delete 同样纠偏（删单样也可能撞同名）", () => {
  assert.equal(disambiguateRecent("r1", "delete", "把瘦肉删了", recs), "r2");
});

test("只有一条同名 → 无歧义，不动", () => {
  const one = [
    { ref: "r1", kind: "food", name: "米饭（蒸）" },
    { ref: "r2", kind: "food", name: "西兰花" },
  ];
  assert.equal(disambiguateRecent("r1", "update", "米饭改成200克", one), "r1");
});

test("用户提到的词不在任何同名片段里 → 不误纠（只纠用户确实提到的名字）", () => {
  // 两条含"瘦肉"，但用户说的是"排骨"，只精确指向其中含排骨的那条时不应被拉偏
  const r = [
    { ref: "r1", kind: "food", name: "炒瘦肉（猪肉）" },
    { ref: "r2", kind: "food", name: "排骨瘦肉（纯瘦）" },
  ];
  // 共有片段是"瘦肉"，用户文本无"瘦肉" → 不触发纠偏
  assert.equal(disambiguateRecent("r2", "update", "排骨改成60克", r), "r2");
});

test("action=append 不纠偏（追加走 target 所在餐语义）", () => {
  assert.equal(disambiguateRecent("r1", "append", "瘦肉那餐再加个蛋", recs), "r1");
});

test("target 是运动记录 → 不纠偏", () => {
  const r = [
    { ref: "r1", kind: "food", name: "炒瘦肉（猪肉）" },
    { ref: "e1", kind: "exercise", name: "跑步" },
  ];
  assert.equal(disambiguateRecent("e1", "update", "跑步改成400卡", r), "e1");
});
