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
| source | text | composition_table / ai / manual |
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
| calories | float | 后端算：calories_100g/100*weight_g |
| protein / fat / carbs | float | 同理 |
| food_confidence | float? | 食物识别把握度 |
| portion_confidence | float? | 份量把握度 |
| source | text | text / voice |
| raw_input | text? | 原始输入 |
| parse_log_id | uuid? | 关联解析日志 |
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
| kind | text | text / record_card / portion_card / candidate_card / clarify_card / query_card / exercise_card / delete_confirm_card |
| content | text? | 文本内容 |
| payload | jsonb? | 卡片数据（候选、份量、营养等） |
| record_id | uuid? | 记录类卡片关联的 food_record（用于实时回填/删除联动显示） |
| created_at | timestamptz | |

索引：`(user_id, date, created_at)`。
卡片显示策略：**查询类卡片冻结**（payload 即当时答案）；**记录类卡片绑 record_id 实时回填**（底层记录改/删则显示更新或"已删除"）。
modify 的 update/append 高置信直执行：record_card 的 `payload.undo` 带 `{record_id, prev_state?}` 支持撤销（见 AI_PARSING_SPEC §8），不进 pending 流程。

## ai_parse_log（解析日志）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| input_text | text | |
| parsed_json | jsonb? | DeepSeek 解析结果 |
| intent | text? | record/query/chat |
| confidence | float? | |
| status | text? | auto/pending/resolved/failed |
| created_at | timestamptz | |

## pending_record（待用户确认）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| type | text | food_choice/portion_choice/clarify/delete_confirm（删除前确认，见 AI_PARSING_SPEC §8） |
| raw_input | text | |
| candidates | jsonb | 候选（含克数估算） |
| status | text | pending/resolved/discarded |
| created_at | timestamptz | |
