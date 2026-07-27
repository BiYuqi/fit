import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasIngredientLoss } from "./parser";

// T67：确定性主料丢失校验——不依赖模型自评的 food_confidence（会虚高，见 T67 背景真机案例）。

test("hasIngredientLoss — 复合菜主料被丢弃时判定丢失（2026-07-14 真机 audit 发现）", () => {
  assert.equal(
    hasIngredientLoss("晚上吃了煎鸡胸肉汤面条850克", [{ canonical: "熟面条" }]),
    true,
  );
});

test("hasIngredientLoss — 拆成多个 item 时任一 item 未覆盖主料也判定丢失", () => {
  assert.equal(
    hasIngredientLoss("吃了一碗牛肉面 加了一个鸡蛋", [
      { canonical: "熟面条" },
      { canonical: "鸡蛋" },
    ]),
    true,
  );
});

test("hasIngredientLoss — 误报护栏：同义归一（鸡蛋→水煮蛋）不触发", () => {
  assert.equal(
    hasIngredientLoss("中午吃了千张80克，一个鸡蛋", [
      { canonical: "千张" },
      { canonical: "水煮蛋" },
    ]),
    false,
  );
});

test("hasIngredientLoss — 误报护栏：derivedRequest（纯肉不算骨头）整体跳过", () => {
  assert.equal(
    hasIngredientLoss("排骨瘦肉80克。纯肉不算骨头", [{ canonical: "猪瘦肉" }]),
    false,
  );
});

test("hasIngredientLoss — 原话没有主料词时不触发（如纯主食）", () => {
  assert.equal(
    hasIngredientLoss("中午吃了一碗米饭", [{ canonical: "米饭" }]),
    false,
  );
});

test("hasIngredientLoss — 无 items 时不触发（防御）", () => {
  assert.equal(hasIngredientLoss("晚上吃了煎鸡胸肉汤面条850克", undefined), false);
  assert.equal(hasIngredientLoss("晚上吃了煎鸡胸肉汤面条850克", []), false);
});
