// Memory Extractor 关键词预筛选单测（T59：显式记忆请求必存）

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { hasConstraintKeyword, CONSTRAINT_KEYWORDS } from "./memory-extract";

describe("T59: 显式记忆请求词表", () => {
  test("新增触发词全部命中 hasConstraintKeyword", () => {
    const words = ["记住", "别忘了", "记下", "以后都", "下次都", "生重", "熟重", "熟的"];
    for (const w of words) {
      assert.ok(CONSTRAINT_KEYWORDS.includes(w), `词表应包含"${w}"`);
      assert.equal(hasConstraintKeyword(`测试${w}测试`), true, `"${w}"应命中`);
    }
  });

  test("2026-07-09 真机丢失案例：现在能命中关键词预筛选", () => {
    assert.equal(
      hasConstraintKeyword("我说的都是熟的饭，谁没事吃生的，这个你得记住"),
      true,
    );
  });

  test("追问场景：'你记住这个习惯不就好了'命中", () => {
    assert.equal(hasConstraintKeyword("你记住这个习惯不就好了？"), true);
  });
});

describe("T59: 负例——不应误伤的操作/纠正类语句", () => {
  test("修改指令不命中关键词预筛选（不会触发 LLM 提取）", () => {
    assert.equal(hasConstraintKeyword("把牛肉面改成大份"), false);
  });

  test("单次纠正不命中关键词预筛选（未要求记住）", () => {
    assert.equal(hasConstraintKeyword("你估太多了，应该是100g"), false);
  });
});
