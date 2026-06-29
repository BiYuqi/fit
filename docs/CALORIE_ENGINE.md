# CALORIE_ENGINE — 计算引擎口径

> 所有公式**唯一定义在此**，别处引用不重抄。计算只在后端发生，AI 不参与。

## 1. BMR（Mifflin-St Jeor）
```
男: BMR = 10*体重kg + 6.25*身高cm - 5*年龄 + 5
女: BMR = 10*体重kg + 6.25*身高cm - 5*年龄 - 161
```

## 2. 活动系数 → TDEE
| activity_level | 系数 |
|---|---|
| sedentary 久坐 | 1.2 |
| light 轻度 | 1.375 |
| moderate 中度 | 1.55 |
| active 高强度 | 1.725 |
| very_active 极高 | 1.9 |
```
TDEE = BMR * 活动系数
```

## 3. 单条食物热量
```
calories = calories_100g / 100 * weight_g
protein/fat/carbs 同理（各自 _100g / 100 * weight_g）
```
`weight_g` 来自 AI 估算的 chosen_label 对应克数，或用户自定义。

## 4. 每日口径
```
今日摄入  calories_in = SUM(food_record.calories WHERE date)
今日消耗  total_out   = TDEE + SUM(exercise_record.calories_burned WHERE date)
缺口      deficit     = total_out - calories_in
今日还可吃 remaining  = target_calories - calories_in   （展示用，可为负）
```

## 5. 目标
```
目标摄入 target_calories = TDEE - daily_deficit   （daily_deficit 默认 500，范围 300~750）
目标蛋白 target_protein  = 体重kg * k             （k 取 1.6~2.2，减脂保肌；默认 1.8）
```
膳食宝塔推荐量仅用于"均衡提示"，不参与上述目标计算。

## 6. 边界
- food_standard 某营养字段为 null（如能量缺失）→ 该项按 0 计并标注该条记录为不完整（可在 UI 弱提示）。
- `is_estimated=true` 的食物算出的热量在 UI 上可标"估算"。
- 运动消耗若 DeepSeek 只给类型+时长，后端按简易 MET 表估 `calories_burned`。
