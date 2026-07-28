// Memory Extractor 关键词预筛选单测（T59：显式记忆请求必存；T74：否认信号必存）

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { hasMemorySignal, CONSTRAINT_KEYWORDS, DENIAL_KEYWORDS } from "./memory-extract";

describe("T59: 显式记忆请求词表", () => {
  test("新增触发词全部命中 hasMemorySignal", () => {
    const words = ["记住", "别忘了", "记下", "以后都", "下次都", "生重", "熟重", "熟的"];
    for (const w of words) {
      assert.ok(CONSTRAINT_KEYWORDS.includes(w), `词表应包含"${w}"`);
      assert.equal(hasMemorySignal(`测试${w}测试`), true, `"${w}"应命中`);
    }
  });

  test("2026-07-09 真机丢失案例：现在能命中关键词预筛选", () => {
    assert.equal(
      hasMemorySignal("我说的都是熟的饭，谁没事吃生的，这个你得记住"),
      true,
    );
  });

  test("追问场景：'你记住这个习惯不就好了'命中", () => {
    assert.equal(hasMemorySignal("你记住这个习惯不就好了？"), true);
  });
});

describe("T74: 否认信号词表", () => {
  test("否认词全部命中 hasMemorySignal", () => {
    for (const w of DENIAL_KEYWORDS) {
      assert.equal(hasMemorySignal(`测试${w}测试`), true, `"${w}"应命中`);
    }
  });

  test("2026-07-27 真机三条否认：陈述类词表一个都不命中，靠否认词表兜住", () => {
    // 这三句是 T74 立项的真实原话——作废通道的输入全靠它们能触发 quickExtract
    const denials = [
      "我排便正常了，你是不是记错了",
      "已经一周了，早就好了",
    ];
    for (const s of denials) {
      assert.equal(
        CONSTRAINT_KEYWORDS.some((kw) => s.includes(kw)),
        false,
        `"${s}" 不该靠陈述词表命中（否则本测试失去意义）`,
      );
      assert.equal(hasMemorySignal(s), true, `"${s}" 应被否认词表命中`);
    }
  });
});

describe("负例——不应误伤的操作/纠正类语句", () => {
  test("修改指令不命中关键词预筛选（不会触发 LLM 提取）", () => {
    assert.equal(hasMemorySignal("把牛肉面改成大份"), false);
  });

  test("单次纠正不命中关键词预筛选（未要求记住）", () => {
    assert.equal(hasMemorySignal("你估太多了，应该是100g"), false);
  });
});
