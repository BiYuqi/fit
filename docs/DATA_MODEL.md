# DATA_MODEL — 数据模型

> 字段在此**唯一定义**，别处只引用不重抄。实现见 `backend/prisma/schema.prisma`（以本文件语义为准）。
> 数据库 PostgreSQL，启用 `pg_trgm`。

## 关系总览
- 一个 `users` 拥有多条 food_record / exercise_record / chat_message / ai_parse_log / pending_record，及每日一行 daily_summary。
- food_record 引用一条 food_standard。

## users（用户）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| account | text unique | 登录名，唯一即可（不一定是邮箱） |
| password_hash | text | argon2 哈希 |
| name | text? | 昵称，可空 |
| gender | enum(male/female) | 算 BMR 用 |
| age | int | |
| height_cm | decimal | |
| weight_kg | decimal | |
| target_weight_kg | decimal | 目标体重 |
| activity_level | enum(sedentary/light/moderate/active/very_active) | 活动系数来源 |
| goal_type | enum(cut/maintain) | 默认 cut |
| daily_deficit | int | 目标每日缺口，默认 500 |
| onboarded | bool | 是否完成 Onboarding |
| created_at | timestamptz | |

## food_standard（食物标准库）
> 由食物成分表导入（见 FOOD_DB_SPEC）。每 100g 可食部数值。
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| name | text | 标准名 |
| aliases | text[] | 别名/俗名 |
| category | text | 类目 |
| edible_ratio | float? | 食部，0~1 |
| calories_100g | float? | 每100g能量(kcal) |
| protein_100g | float? | |
| fat_100g | float? | |
| carbs_100g | float? | |
| fiber_100g | float? | |
| is_composite | bool | 复合菜/外卖 |
| is_estimated | bool | AI估算/均值，低可信 |
| source | text | composition_table / ai / ai_reviewed / manual（ai_reviewed=估算条目已被 pro 复核，见 T33） |
| created_at | timestamptz | |

约束：`unique(name, category)`（供 upsert）。索引：`name` 的 GIN trigram（模糊匹配）。

## food_record（饮食记录 · 事实源）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| food_id | uuid FK → food_standard | |
| meal_type | enum(breakfast/lunch/dinner/snack) | |
| portion_label | enum(small/medium/large/custom) | |
| weight_g | float | 最终克数（AI估或用户定） |
| count | float? | 可数份量的份数（AI 从原话提取，「两个」→2、「一碗」→1）；无明确可数份量（如「50克瘦肉」）时为空。仅供餐食卡展示 `食物名 ×count`，**不参与任何热量计算**（铁律 1：账只由 weight_g×每100g 算）。见 AI_PARSING_SPEC。 |
| count_unit | text? | 与 count 配套的量词（「个/碗/片/根」）；count 为空时同为空。 |
| calories | float | 后端算：calories_100g/100*weight_g；若 `calories_source=user_override` 则是用户直接指定的值（modify.update change.calories，T40，见 LEARNING_SPEC §3） |
| protein / fat / carbs | float | 同理；`user_override` 时按新旧热量比例回推，不是重新估算 |
| calories_source | text | computed（默认，food×grams 算出）/ user_override（用户直接报的热量，T40/T66）；modify 改 food/grams/food_desc 时会被重置回 computed |
| calories_computed | float? | 仅 `calories_source=user_override` 时有值：系统本会按 food×grams 算出的热量（偏差三元组的一角，与 `food_id`/`calories` 一起构成 food_id/系统值/用户值，供 LEARNING_SPEC 食物库偏差学习用，T66）。T66 上线前的存量 `user_override` 记录为空，不回填——回填只能靠反算，会把不精确的数据固化成"精确采集"，`scripts/audit.ts` 对空值行退回按当前 food_standard 反算并标注 |
| food_confidence | float? | 食物识别把握度 |
| portion_confidence | float? | 份量把握度 |
| source | text | text / voice |
| raw_input | text? | 原始输入 |
| parse_log_id | uuid? | 关联解析日志 |
| alias_canonical | text? | 若由用户食物直连（`user_food_alias` streak≥2）自动匹配，存匹配用的 canonical；撤销/改食物时据此联动清该 alias 的 streak（T30，见 LEARNING_SPEC §6 §7） |
| predicted_grams | float? | AI 原估克数（applyBias 之前）；隐式确认 job 与 discuss 偏差说明的 predicted 基准（T31，见 LEARNING_SPEC §5 §7） |
| scene | text? | 进食场景 takeout/canteen/home/unknown，parser 从原话提取（T32，见 LEARNING_SPEC §4） |
| date | date | 归属日期 |
| created_at | timestamptz | |

索引：`(user_id, date)`。

## exercise_record（运动记录 · 事实源）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| type | text | 运动类型 |
| duration_min | int? | |
| calories_burned | float | 额外消耗 |
| user_reported | bool | 热量是用户自报（真值）还是 MET 估算，默认 false。改时长时 true 则沿用原热量、false 才按新时长重算（T73） |
| source | text | text / voice |
| raw_input | text? | |
| date | date | |
| created_at | timestamptz | |

索引：`(user_id, date)`。

## daily_summary（每日汇总缓存 · 事实源）
> 每次写记录后重算。
| 字段 | 类型 | 语义 |
|---|---|---|
| user_id | uuid | PK 之一 |
| date | date | PK 之一 |
| calories_in | float | 当日摄入 |
| bmr | float | 基础代谢 |
| tdee | float | 总消耗基线 |
| exercise_out | float | 额外运动消耗 |
| total_out | float | tdee + exercise_out |
| deficit | float | total_out − calories_in |
| protein / fat / carbs | float | 当日合计 |
| target_calories | float | tdee − daily_deficit |
| target_protein | float | 目标蛋白 |
| updated_at | timestamptz | |

## chat_message（聊天记录 · 展示层，非事实源）
> 仅供 Chat 页回放显示。Today/History 绝不读它。保留约 1 年（见 ARCHITECTURE §6）。
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| date | date | 归属对话日（线程分组用） |
| role | enum(user/assistant) | 谁发的 |
| kind | text | text / meal_card / portion_card / candidate_card / clarify_card / exercise_card / delete_confirm_card / event |
| content | text? | 文本内容 |
| payload | jsonb? | 卡片数据（候选、份量、营养等） |
| record_id | uuid? | 记录类卡片关联的 food_record（用于实时回填/删除联动显示） |
| created_at | timestamptz | |

索引：`(user_id, date, created_at)`。
卡片显示策略：**查询类卡片冻结**（payload 即当时答案）；**meal_card 实时组装 + created_at 跟随**（T46）——按 (用户, 餐归属日, 餐次) 一餐一卡，落库 payload 只存组装键 `{ meal_key: { date, meal_type }, last_changes }`（`meal_key.date` 与本表 date 独立：跨天修改时餐归属日 ≠ 对话日），明细 `items[]` 与营养 `totals` 在响应/GET 时从 food_record 实时组装、不落库、永不过期；内容变更（记录/修改/追加/删除/撤销）时同一条消息 created_at 刷成当前时间，前端按时间重排后卡片浮到聊天流末尾。
`payload.last_changes`（T47 单槽 `last_change` → T53 升级为**按 record_id 存的数组**）：该餐每条记录各自的撤销信息 `[{record_id, prev_state?}]`（有 prev_state = update 撤销还原，无 = append 撤销删除）。一轮 multi 批量改 N 条，N 条各留独立撤销态、互不覆盖；同 record_id 再次修改覆盖该条、`/api/records/:id/undo` 撤销后只清该条；enrich 时剪掉已不在 items 里的陈旧撤销态（删除/移餐后自然清理）；批量改餐次不写。旧 payload 的单槽 `last_change` 读时兼容包成单元素数组。
modify 的 update/append 高置信直执行，不进 pending 流程（见 AI_PARSING_SPEC §8）。

`kind=event`（T49）：系统回执降级为居中小字事件行（视觉同时间分隔符量级，非气泡），前端渲染见 DESIGN_SPEC §3。payload：
```json
{
  "event_type": "deleted | modified",
  "text": "已删除 李子 · -38 kcal",   // 后端组装好的展示文案（铁律1：数字来自后端）
  "record_id": "...",               // deleted 时是已被删除记录的旧 id，仅供展示/追溯，不可再查
  "undo": { "prev_state": { ... } }, // 仅 event_type=deleted 时有：被删记录完整快照，供 /api/chat/events/:id/undo 按快照重建（新 id）
  "undone": false
}
```
`event_type=modified`（modify 的 update 高置信直执行的回执，delta 文案）不带 `undo`——撤销走该餐 meal_card 的 `payload.last_changes`（同一条 undo 链路，卡片项级撤销按钮可见即可用，见 T47/T53）。
`event_type=deleted`（modify 的 delete，T49 起免确认直接执行）带 `undo.prev_state`——记录已被真删除，没有 meal_card 项可依附撤销按钮，撤销必须由事件行自身发起、按快照重建新记录。
存量（T49 之前）产生的 `delete_confirm_card` / 旧 modify.update 的纯文本回执按原样回放，不迁移（铁律 3）；对应的 `pending_record.type=delete_confirm` 分支在服务端保留，仅供这些存量卡片点击 resolve，不再有新增来源。

## ai_parse_log（解析日志）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| input_text | text | |
| parsed_json | jsonb? | DeepSeek 解析结果；`intent=resolve` 时为卡片动作 `{action, food_name, portion_label?, grams?…}` |
| intent | text? | record/query/chat/modify/discuss/resolve（resolve=卡片点选，input_text 固定为 `[点选卡片]`，见 AI_PARSING_SPEC §7） |
| confidence | float? | |
| status | text? | auto/pending/resolved/failed |
| reply_summary | text? | AI 回复摘要（T37 双向记忆，L0 的 AI 侧来源）：record/modify 存回复模板文本，chat/query/discuss 存回复截断 ~150 字，resolve 存确认摘要（如"确认：煎饼果子 中份 450g"）。不额外调 AI 做摘要 |
| created_at | timestamptz | |

## pending_record（待用户确认）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| type | text | food_choice/portion_choice/clarify/delete_confirm（T49 起删除免确认直接执行，delete_confirm 只为存量卡片保留，不再有新增，见 AI_PARSING_SPEC §8） |
| raw_input | text | |
| candidates | jsonb | 候选（含克数估算） |
| status | text | pending/resolved/discarded |
| created_at | timestamptz | |

## 学习系统表（语义与算法见 LEARNING_SPEC；随 T29/T30/T31 建）

### learning_event（学习事件：预测 vs 实际，append-only · T29）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| food_record_id | uuid? FK | 关联记录（discuss 注入偏差说明按此查） |
| food_id | uuid? FK → food_standard | |
| category | text? | 冗余存，更新时免 join |
| scene | text? | takeout/canteen/home/unknown（T32 起有值） |
| predicted_grams | float | AI 原始估算（applyBias 之前） |
| applied_grams | float | applyBias 之后展示给用户的 |
| final_grams | float | 用户最终确定 |
| predicted_label / final_label | text? | |
| signal_type | text | explicit_gram / custom_gram / card_choice / implicit_accept / delete / calorie_override / food_desc_correction（后两者 T40，权重0，只记档不训练克数偏差） |
| signal_weight | float | 见 LEARNING_SPEC §3 |
| log_ratio | float? | ln(final/predicted)，训练用误差 |
| parse_log_id | uuid? FK | |
| created_at | timestamptz | |

索引：`(user_id, food_id, created_at)`。

### user_bias（三层偏差后验 · T31）
| 字段 | 类型 | 语义 |
|---|---|---|
| user_id | uuid | PK 之一 |
| scope | text | food / category / scene，PK 之一 |
| scope_key | text | food_id / 类目名 / 场景名，PK 之一 |
| mu | float | log-ratio 后验均值，默认 0 |
| sigma2 | float | 后验方差，默认 0.09 |
| n_eff | float | 有效样本数（封顶 20），默认 0 |
| updated_at | timestamptz | |

### user_food_alias（用户食物直连 · T30）
| 字段 | 类型 | 语义 |
|---|---|---|
| user_id | uuid | PK 之一 |
| canonical | text | parser 归一名，PK 之一 |
| food_id | uuid FK → food_standard | 用户选定的映射 |
| hits | int | 累计选择次数 |
| streak | int | 连续选同一个的次数；选了别的/逃生口/撤销 → 清零 |
| last_chosen_at | timestamptz | |

### bias_update_log（模型更新审计，可回放回滚 · T31）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid FK → learning_event | |
| user_id | uuid | |
| scope / scope_key | text | |
| mu_before / sigma2_before / n_eff_before | float | |
| mu_after / sigma2_after / n_eff_after | float | |
| clamped | bool | 该观测是否触发截断（污染防护） |
| created_at | timestamptz | |

### food_review_log（估算食物复核日志 · T33）
> pro 重估的审计记录，兼幂等标记：该 food 有行即视为已复核，job 不再重复调用（rejected 留待人工复核，不自动重试）。机制见 FOOD_DB_SPEC §3。

| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| food_id | uuid FK → food_standard | |
| status | text | updated / rejected_energy_check / rejected_category_outlier |
| old_values | jsonb | 复核前营养值（calories/protein/fat/carbs/fiber _100g） |
| new_values | jsonb | pro 重估值，同结构；rejected 时也存，供人工复核参考 |
| category_mean | float? | 判定时同类目标准层热量均值（类目无标准层条目时 null，跳过离群校验） |
| ref_count | int | 触发复核时的 food_record 引用次数 |
| model | text | 复核用模型，默认 deepseek-v4-pro |
| created_at | timestamptz | |

索引：`(food_id)`。

### weight_log（体重历史 · T29 起采集，T34 消费）
| 字段 | 类型 | 语义 |
|---|---|---|
| user_id | uuid | PK 之一 |
| date | date | PK 之一（同一天多次上报覆盖当天那行） |
| weight_kg | decimal | 两条写入路径：①改档案体重时后端顺手 append（静默）——**首次引导**与**设置页改体重**触发，**「重看引导」提交除外**（`is_review=true`，重看是回看/调目标不是称重，T51）；②聊天 `record_weight` 意图用户显式上报实测体重（T51，见 AI_PARSING_SPEC §13）。两者都**只**写本表，绝不改 `user.weight_kg`（初始体重） |
| created_at | timestamptz | |
