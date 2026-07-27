# TASKS — 任务总览

> 本文件只放**依赖图**与**执行顺序**。每个任务的"做什么/验收/提示词"在 `docs/tasks/Txx-*.md`，**不在此重复**。
> 用法：一次只做一个任务，按下方顺序，自测验收通过再下一个。
> 状态：⬜待办 / 🔄进行中 / ✅完成。**任务验收通过后更新两处**：本表该行 + `tasks/Txx.md` 顶部状态行。

**进度：63 / 72**　里程碑：✅ M1 命令行心跳(T07)　✅ M2 后端全通(T12)　✅ 前端可用(T19)　⬜ 可出包(T21)　✅ E 对话上下文(T23)　✅ L 学习闭环(T31)　✅ C 对话智能(T40)　✅ G 餐食卡(T48)　✅ M 语义记忆(T56)　⬜ 对话精度 R2(T72)　⬜ 估值层 E(T71)

## 分轨
- **基建 S**：T01
- **数据 D**：T02 T03
- **后端核心 B**：T04–T12
- **前端 F**：T13–T20
- **打磨 P**：T21
- **增强 E（对话上下文）**：T22 T23（后端为主，T23 含前端卡片/撤销，已并入 T16）
- **匹配质量 Q**：T24（字面误匹配）T25（生/熟热量虚高）
- **增强 E（聊天体验）**：T26（聊天搜索 + 数据本地化）T27（SQLite 搜索 + 微信式窗口定位）T35（发送失败可感知 + 重试）
- **自学习 L**：T28（chat.ts 拆分·前置）T29（信号采集）T30（食物直连）T31（份量偏差·闭环）T32（场景）T33（估算复核）T34（体重校准）。规范见 `LEARNING_SPEC.md`
- **对话智能 C（2026-07-03 体检立项）**：T36（上下文补全 week/month + L0 时间）T37（双向记忆 reply_summary + 卡片动作进 L0）T38（pending 感知·文字应答卡片）T39（回答升 pro + 人设提示词·只读路径禁谎称操作）T40（食物修正闭环：改热量 + 属性修正重估）T41（对话回归评测集：真实失败案例回放）T42（chosen_label 护栏·T41 首日抓获，优先）T43（历史日期查询补明细 + modify 反问句护栏，2026-07-04 真实使用发现，收尾）T44（查询计划：AI 填单、后端执行的通用历史查询，一步到位删 T43 正则老路，2026-07-04 立项）T45（复合动作 multi：一条消息多个独立动作按序执行，2026-07-04 真实翻车立项）
- **餐食卡 G（P3 同餐食物分组，2026-07-04 立项）**：T46（后端 meal_card：一餐一卡 + 实时组装 + 卡片跟随）T47（modify/删除/撤销原地刷新 + 前端按 id upsert）T48（MealCard 组件：折叠/展开/项级撤销）。决策记录见 `FEATURE_CANDIDATES.md §P3`
- **批量修改 G3（2026-07-05 真机翻车立项）**：T53（每样值不同走 multi 不走 target 数组 + 后端护栏不静默丢首条 + 餐卡 last_change→last_changes 每条各自独立撤销）。AItrace 实锤：multi record+record 已生产验证，缺的是 multi-modify 触发 + 撤销单槽
- **聊天降噪 N（2026-07-04 真机使用立项）**：T49（回执降级为居中事件行 + 免确认删除可撤销 + "删除一个X"量词解析为减量 update）
- **录入采信 R（2026-07-04 真机使用立项）**：T50（record 阶段采信用户直报运动消耗：一句"打球65分钟消耗590卡"直接落 590，不必再『改成X卡』；食物侧同缺口但罕见且路径重，留待单独立项）
- **体重记录 W（2026-07-05 真机死循环立项）**：T51（聊天 `record_weight` 意图：口头上报实测体重只 append `weight_log`、绝不改初始体重 + 最新实测点注入上下文 + 收敛 weight_log 采集口径：重看引导提交不当测点）
- **餐食卡份数 G2（2026-07-05 真机观感立项）**：T52（AI 出结构化 `count/count_unit`，餐食卡明细主显示 `食物名 ×N` 替代 `raw_input` 长文案；份数只展示、不参与算账）
- **性能优化 X（2026-07-08 真机体验立项）**：T57（全页面 SQLite 持久化缓存：Today/History/Settings/Profile 对标 Chat 本地优先，去全屏转圈）
- **对话可信 V（2026-07-09 真机体检立项，账号 outoftoken）**：T58（营养口径接地：prompt 注入系统事实 + RecordRef 补宏量素 + 欧包数据订正——修「系统按生重算」幻觉与聊天/记录数字打架）T59（显式记忆请求必存：「你得记住」触发词 + 提取 prompt 例外规则 + 记录约定归 preference）T60（省略句追问绑定最近实体：「50克蛋白有多少」不接错话题）T61（产品投诉分流：报障不再被「超出服务范围」怼回）
- **补记跨天 D2（2026-07-11 真机翻车立项，账号 outoftoken）**：T62（record 识别"昨晚/前天"相对日期词直接落对自然日 + modify 新增 change.date_offset 把记录事后改到别的自然日，双日 recompute + 双卡刷新；四次纠正因"日期词误判成餐次词"全部空操作静默失败后立项）
- **对话精度 R2（2026-07-27 立项）**：先落审计工具再定范围——T63（`npm run audit` 明示信号扫描，✅已完成）扫 443 条真实消息，捞出 5 类真实缺陷，其中 **2 类此前无人投诉、已静默 3 周**。据此排出：T64（宏量素修改协议缺失·**唯一会静默写错数据**，最高优先）T65（显式指令夹在长文本里被 discuss 吞）T66（用户终值采信贯通 record 全链路 + B 轨三元组接缝，兑现 T50 挂起的食物侧）T67（复合菜主料丢失确定性校验，替代虚高的自评 food_confidence）T68（餐次归属：item 级 meal_type + 正则多信号时交还 AI）T69（PERSONA_BASE 去禁令堆叠）T72（**收口**：四个 /clear 会话各改同一份 SYSTEM_PROMPT 后，唯一一次通读全文合并去重 + 用 audit 复核成效）。
  > **关键认识**：数据显示过去 27 个对话任务**不是"拆东墙补西墙"**——T42 修复后 88/88 全对、日期词错误全部集中在 T62 上线当天之后零复发，补丁都守住了。真问题是**每类 bug 都要等用户骂了才被发现**，故先做 T63 把发现路径换成"跑一遍就知道"。
  > **方案决策**：评估过把 parser 拆成 Router+Specialist 两段式（业界常见意图路由模式），否掉——它把 1 次 parse 拆成 2 次，在本已很长的调用链上是**往里加不是往外减**，且不解决任何一个实际 bug。改走"确定性明示信号层（`src/services/explicit-signals.ts`，审计与运行时共用一份）+ 规则补全 + few-shot"。
- **估值层 E（2026-07-27 立项，与 R2 分轨）**：T70（食物库权威分级 + 变体命名叠加脏条目清理，**无需决策可直接做**）T71（用户纠正回流食物库，**待拍板**，硬依赖 T66 的三元组）。
  > **为什么与 R2 分轨**：验收方式不同（R2 可机器断言"有没有照用户说的做"，E 无 ground truth——葱花饼到底多少卡没人知道）；风险面差一个量级（E 动 `FoodStandard` 全局表，无 user_id，影响所有用户全部历史记录）；E 有产品决策而 R2 全是纯 bug，混轨会让决策堵住本可立刻修的缺陷。
  > **审计实测**：真实记录 **83.6% 命中的是 AI 估算条目**而非成分表（1632 条成分表是原料级，用户说的是成品菜，靠扩库追不上）。所以"食物库权重太高"的实质是**一次性 AI 估算冻结成了永久权威**：`matchFood` 的精确/alias/trgm 均不过滤 `is_estimated`，119 条估算只有 7 条被复核过。

## 依赖图
```
T01 ─┬─ T02 ── T03 ───────────────┐
     │                            │
     └─ T04 ─┬ T05(需T03) ┐       │
             └ T06        ├ T07(M1)│
                          ┘        │
T07 ─ T08 ─ T09 ─ T10 ─ T11 ─ T12(M2)
                                   │
T13 ─ T14 ─┬ T15(需T09)            │
           ├ T16(需T11/T12)  ← 核心 │
           ├ T17(需T12)            │
           ├ T18(需T12)            │
           ├ T19(需T09)            │
           └ T20                   │
T21（贯穿，最后收尾）

T22(需T04/T10/T11) ── T23(需T22/T05/T06/T11)   增强 E：对话上下文

T28(需T27) ─ T29 ─┬─ T30            自学习 L（LEARNING_SPEC）
                  ├─ T31 ── T32
                  ├─ T33
                  └─ T34(需数周 weight_log 积累，最后做)

T36(需T22) ─ T37(需T22/T28) ─ T38   对话智能 C；T39 无硬依赖，建议排在 T36/T37 之后
T40(需T28，建议在 T37/T39 后)        对话智能 C：修正闭环，与 T30 alias 联动
T41(无依赖，建议最先做)              对话智能 C：回归评测集，T36–T40 验收场景逐个沉淀进来
T43(需T40，修T40引入的回归风险)      对话智能 C：历史日期明细 + modify 反问句护栏
T44(需T41/T43)                      对话智能 C：查询计划（AI 填单、后端执行），含删 T43 正则老路
T45(需T41)                          对话智能 C：复合动作 multi（一条消息多个独立动作）

T46(需T45) ─ T47 ─ T48              餐食卡 G：同餐分组一餐一卡 + 原地刷新 + MealCard 组件

T49(需T47/T48)                      聊天降噪 N：事件行回执 + 免确认删除 + 量词语义

T50(无依赖)                         录入采信 R：record 阶段直采用户自报运动消耗

T53(需T45/T47/T48)                  批量修改 G3：multi-modify 触发 + 后端护栏 + 项级独立撤销

T54(无强依赖，需 pgvector)            语义记忆 M：地基——DB + Scoring Engine + Store（零侵入）
  └─ T55(需T54)                      语义记忆 M：接入——提取管线 + compressContext 注入
       └─ T56(需T55)                 语义记忆 M：闭环——cron 维护 + Memory Center API + 前端管理页

T58(无强依赖，建议最先)               对话可信 V：营养口径接地（系统事实 + RecordRef 宏量素 + 数据订正）
T59(需T55)                          对话可信 V：显式记忆请求必存（词表 + 提取 prompt 例外）
T60(无强依赖，建议在 T58 后)          对话可信 V：省略句追问绑定最近实体
T61(无依赖)                          对话可信 V：产品投诉分流话术

T63(✅无依赖，已完成)                对话精度 R2：审计工具——先量化再立项，其余任务由它的扫描结果推出
T64 ─ T65 ─ T67 ─ T68               对话精度 R2：均改 parser.ts 同段 SYSTEM_PROMPT，无硬依赖但按序做避免打架
T66(无强依赖，含 B 轨三元组接缝)      对话精度 R2：改动面最大（4 个落库/建卡入口）
T69(只碰 answers.ts，随时可插)       对话精度 R2：人设语气
T72(需 T64–T69 全部完成)             对话精度 R2：SYSTEM_PROMPT 收口 + audit 成效复核，**必须最后做**

T70(无依赖，与 R2 可并行)            估值层 E：权威分级 + 脏条目清理
  └─ T71(硬依赖 T66 三元组，待决策)   估值层 E：用户纠正回流
```
说明：T13 前端骨架不依赖接口，可在后端推进时并行起；但真实联调要等对应后端任务（T15↔T09，T16↔T11/T12，T17/T18↔T12，T19↔T09）。

## 执行顺序（交给 Claude Code 的次序）
```
T01 → T02 → T03 → T04 → T05 → T06 → T07(✅M1)
    → T08 → T09 → T10 → T11 → T12(✅M2)
    → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20
    → T21
    → T22 → T23   (增强 E：对话上下文与指代修改；依赖 M2，可在 T21 前后插入)
    → T24 → T25   (匹配质量 Q：字面误匹配、生/熟热量虚高；依赖 T05)
    → T26         (增强 E：聊天搜索 + 数据本地化；依赖 T11/T12/T16)
	    → T27         (增强 E：SQLite 搜索 + 微信式窗口定位；依赖 T26)
    → T28 → T29 → T30 → T31 → T32 → T33 → T34   (自学习 L；T34 需 weight_log 积累数周，可延后)
    → T35         (增强 E：发送失败可感知 + 重试；依赖 T16，随时可插入)
    → T41 → T42 → T36 → T37 → T38 → T39 → T40 → T43   (对话智能 C：先立回归评测集，T42 数据污染优先修，再上下文补全→双向记忆→pending 感知→回答升级→修正闭环→收尾补漏)
    → T44   (对话智能 C：查询计划架构，终结"每种问法手写正则+查询函数"，单路径一步到位)
    → T45   (对话智能 C：复合动作 multi，一句多事不丢动作不串修饰词)
    → T46 → T47 → T48   (餐食卡 G：同餐食物分组，一餐一卡原地更新 + 卡片跟随)
    → T49   (聊天降噪 N：回执事件化 + 免确认删除 + "删除一个X"量词语义)
    → T50   (录入采信 R：record 阶段直采用户自报运动消耗，消除"改成X卡"两步)
	    → T51 → T52 → T53   (体重+餐食卡份数+批量修改)
	    → T54 → T55 → T56   (语义记忆 M：用户画像层——地基→提取注入→生命周期+管理中心)
    → T57   (性能优化 X：全页面 SQLite 持久化缓存，去转圈)
    → T58 → T59 → T60 → T61   (对话可信 V：先修口径接地再修记忆/指代/话术；T60 复用 T58 的记录真值)
    → T62   (补记跨天 D2：record/modify 相对日期词落对自然日)
    → T63(✅)   (对话精度 R2：先落审计工具，用数据定范围，别拍脑袋立项)
    → T64 → T65 → T66 → T67 → T68 → T69   (对话精度 R2：按严重度——静默写错数据 → 指令被吞 → 终值采信 → 丢主料 → 餐次归属 → 语气)
    → T72   (对话精度 R2 收口：通读 SYSTEM_PROMPT 合并去重 + audit 对比基线，不做则本轮只是"更有依据的补丁堆叠")
    → T70   (估值层 E：权威分级 + 脏条目，可与 R2 并行)
    → T71   (估值层 E：纠正回流，需先拍板 Q1-Q4 且依赖 T66)
```

## 任务清单
| 状态 | ID | 文件 | 一句话 |
|----|----|------|--------|
| ✅ | T01 | tasks/T01-scaffold.md | 仓库骨架：backend/frontend 两个独立项目 + 后端 health |
| ✅ | T02 | tasks/T02-db-migrate.md | Prisma 迁移 + pg_trgm 索引 |
| ✅ | T03 | tasks/T03-seed-food-db.md | 食物库导入与清洗（含能量自检） |
| ✅ | T04 | tasks/T04-deepseek-parse.md | DeepSeek 客户端 + 解析协议 + 意图路由 |
| ✅ | T05 | tasks/T05-food-matcher.md | 食物匹配管线（pg_trgm + 兜底） |
| ✅ | T06 | tasks/T06-calorie-engine.md | 计算引擎（BMR/TDEE/热量） |
| ✅ | T07 | tasks/T07-cli-heartbeat.md | 命令行心跳：一句话→热量（M1） |
| ✅ | T08 | tasks/T08-auth.md | 注册/登录（account+password） |
| ✅ | T09 | tasks/T09-profile-onboarding.md | 用户档案 + Onboarding 算 TDEE |
| ✅ | T10 | tasks/T10-daily-summary.md | 每日汇总 + 上下文卡 |
| ✅ | T11 | tasks/T11-chat-endpoint.md | /chat/message + /pending/resolve + 聊天落库 |
| ✅ | T12 | tasks/T12-query-endpoints.md | 查询接口 + 聊天记录接口（M2） |
| ✅ | T13 | tasks/T13-expo-scaffold.md | Expo 骨架 + 导航 + Liquid Glass 主题 |
| ✅ | T14 | tasks/T14-client-auth.md | API 客户端 + 认证态 + 登录页 + 本地缓存 |
| ✅ | T15 | tasks/T15-onboarding-ui.md | Onboarding 七步 UI |
| ✅ | T16 | tasks/T16-chat-ui.md | Chat 页（核心，各类卡片+持久化，含 modify 卡片/撤销） |
| ✅ | T17 | tasks/T17-today-ui.md | Today 页 |
| ✅ | T18 | tasks/T18-history-ui.md | History 页 |
| ✅ | T19 | tasks/T19-settings-ui.md | Settings 页（含清除缓存） |
| ✅ | T20 | tasks/T20-voice-input.md | 语音输入 |
| ⬜ | T21 | tasks/T21-polish.md | 状态/边界/保留任务/EAS 收尾 |
| ✅ | T22 | tasks/T22-context-memory.md | 对话记忆包 L0/L1/L2 注入 prompt（不丢上下文）|
| ✅ | T23 | tasks/T23-modify-record.md | modify 指代修改 update/delete/append + 确认卡/撤销 |
| ✅ | T24 | tasks/T24-match-arbitration.md | 食物匹配裁决层：字面只召回，AI 裁决（修字面误匹配）|
| ✅ | T25 | tasks/T25-cooked-canonical.md | 主食 canonical 取熟形 + 生/熟匹配护栏（修生重热量虚高）|
| ✅ | T26 | tasks/T26-chat-search.md | 聊天搜索 + 数据本地化：去日期pill、搜索弹窗、跨日期跳转 |
| ✅ | T27 | tasks/T27-chat-search-sqlite.md | SQLite 搜索 + 微信式窗口加载定位（替代 T26 内存搜索） |
| ✅ | T28 | tasks/T28-chat-split.md | chat.ts 拆分重构（学习系统前置，纯搬家零行为变化） |
| ✅ | T29 | tasks/T29-learning-events.md | 学习事件采集：learning_event/weight_log + 四 hook（只采不用） |
| ✅ | T30 | tasks/T30-food-alias.md | 食物直连：streak≥2 跳候选卡 + 逃生口 + undo 联动 |
| ✅ | T31 | tasks/T31-portion-bias.md | 份量偏差闭环：user_bias + applyBias + discuss 注入（L 里程碑） |
| ✅ | T32 | tasks/T32-scene-bias.md | 场景偏差：parser scene 字段 + scene 层融合 |
| ✅ | T33 | tasks/T33-estimated-food-review.md | 估算食物复核：高频 is_estimated 条目 pro 重估 |
| ⬜ | T34 | tasks/T34-weight-calibration.md | 体重地面真值校准：周对账收敛有效 TDEE |
| ⬜ | T35 | tasks/T35-send-failure-retry.md | 发送失败可感知 + 重试：失败气泡保留 + 红色感叹号（微信式） |
| ✅ | T36 | tasks/T36-context-completeness.md | 上下文补全：week/month 聚合注入 compressContext + L0 时间标注 |
| ✅ | T37 | tasks/T37-bidirectional-memory.md | 双向记忆：ai_parse_log.reply_summary 回填 + 卡片动作进 L0 |
| ✅ | T38 | tasks/T38-pending-aware-parse.md | pending 感知：注入待确认卡 + resolve_pending 意图，文字应答卡片 |
| ✅ | T39 | tasks/T39-answer-quality.md | 回答质量：chat/query/discuss 升 pro + 人设提示词 + 只读路径禁谎称操作 |
| ✅ | T40 | tasks/T40-food-correction.md | 食物修正闭环：改热量(用户真值) + 属性修正重估 + alias 自愈（C 里程碑） |
| ✅ | T41 | tasks/T41-conversation-eval.md | 对话回归评测集：一次性账号回放真实失败案例，意图/落库/红线三层断言 |
| ✅ | T42 | tasks/T42-portion-label-guard.md | chosen_label 护栏：用户明示克数被静默改档（T41 首日抓获，数据污染级） |
| ✅ | T43 | tasks/T43-query-detail-and-meta-guard.md | 历史日期查询补明细 + modify 反问句护栏（T40 引入的回归风险，真实使用发现） |
| ✅ | T44 | tasks/T44-query-plan.md | 查询计划：AI 填结构化查询单、后端白名单执行器确定性执行，单路径替换 T43 正则 |
| ✅ | T45 | tasks/T45-multi-action.md | 复合动作 multi：ops 数组按序执行 record/modify，raw 子句防修饰词串台 |
| ✅ | T46 | tasks/T46-meal-card-backend.md | 餐食卡后端：一餐一卡(日期+餐次) + food_record 实时组装 + created_at 跟随 |
| ✅ | T47 | tasks/T47-meal-card-refresh.md | 餐食卡原地刷新：modify/删除/撤销全路径 + 前端按 id upsert 重排序 |
| ✅ | T48 | tasks/T48-meal-card-ui.md | MealCard 组件：折叠汇总/展开明细/项级撤销/已清空态 |
| ✅ | T49 | tasks/T49-chat-noise-reduction.md | 聊天降噪：回执降级事件行 + 免确认删除可撤销 + 量词删除解析为减量（补记④：份量确认回执直接去掉） |
| ✅ | T50 | tasks/T50-record-exercise-calories.md | 录入采信：record 阶段直采用户自报运动消耗（"打球65分钟消耗590卡"一步落库） |
| ✅ | T51 | tasks/T51-record-weight.md | 体重记录：聊天 record_weight 只 append weight_log 不改初始体重 + 最新实测点入上下文 + 重看引导不当测点 |
| ✅ | T52 | tasks/T52-meal-card-count.md | 餐食卡份数：AI 出结构化 count/count_unit，明细主显示 `食物名 ×N` 替代 raw_input 长文案 |
| ✅ | T53 | tasks/T53-batch-modify.md | 批量修改正确性 + 项级独立撤销：每样值不同走 multi、后端护栏不静默丢、last_change→last_changes 每条各自撤销 |
| ✅ | T54 | tasks/T54-memory-phase1-foundation.md | 语义记忆地基：user_memory 表 + Scoring Engine 纯函数 + Memory Store CRUD（零侵入） |
| ✅ | T55 | tasks/T55-memory-phase2-extract-inject.md | 语义记忆接入：提取管线（同步 constraint + 异步 full）+ compressContext 注入 |
| ✅ | T56 | tasks/T56-memory-phase3-lifecycle-ui.md | 语义记忆闭环：cron 维护 + Memory Center API + 前端管理页 |
| 🔄 | T57 | tasks/T57-sqlite-cache-for-all-pages.md | 全页面 SQLite 持久化缓存：Today/History/Settings/Profile 去转圈（2026-07-10 设计重写：写穿+共享hook，待真机重验） |
| ✅ | T58 | tasks/T58-chat-nutrition-grounding.md | 营养口径接地：prompt 系统事实段 + RecordRef 补 p/f/c + 欧包重复条目订正 |
| ✅ | T59 | tasks/T59-memory-explicit-request.md | 显式记忆请求必存：「记住」触发词 + 提取 prompt 例外 + cooked_weight_reporting |
| ✅ | T60 | tasks/T60-ellipsis-followup-context.md | 省略句追问绑定最近实体：先复盘 prompt 供给再加指代规则 + eval 用例 |
| ✅ | T61 | tasks/T61-complaint-fallback.md | 产品投诉分流：报障话术承认+安抚，off-topic 模板只留给真无关请求 |
| ✅ | T62 | tasks/T62-record-date-offset.md | 补记跨天：record 识别相对日期词落对自然日 + modify.change.date_offset 事后改天（双日 recompute + 双卡刷新）|
| ✅ | T63 | tasks/T63-conversation-audit-tool.md | 对话审计工具 `npm run audit`：明示信号采纳率扫描，零 LLM，把发现路径从「用户骂」换成「跑一遍」 |
| ✅ | T64 | tasks/T64-macro-nutrient-modify.md | 宏量素修改协议缺失：「把蛋白质改成8克」→ 系统把重量改成200克，**唯一会静默写错数据**，最高优先 |
| ✅ | T65 | tasks/T65-explicit-instruction-priority.md | 显式指令优先级：「改成850卡」夹在长说理文本里被整句判成 discuss，指令被吞 |
| ✅ | T66 | tasks/T66-record-calorie-override.md | 用户终值采信贯通 record/append/multi 四个落库入口 + 采集偏差三元组（B 轨接缝，兑现 T50 挂起项） |
| ✅ | T67 | tasks/T67-composite-dish-ingredient-guard.md | 复合菜主料丢失：确定性校验替代虚高自评置信度（「煎鸡胸肉汤面条」→「熟面条」still 0.85） |
| ⬜ | T68 | tasks/T68-meal-attribution.md | 餐次归属：item 级 meal_type（一句跨两餐）+ 正则多信号时交还 AI（别覆盖掉 AI 判对的答案） |
| ⬜ | T69 | tasks/T69-persona-warmth-rewrite.md | PERSONA_BASE 去禁令堆叠换 few-shot 正例，保留三条硬底线 |
| ⬜ | T70 | tasks/T70-food-db-authority-tiers.md | 食物库权威分级：`is_estimated` 不该与成分表等权 + 清变体命名叠加脏条目 |
| ⬜ | T72 | tasks/T72-prompt-consolidation.md | **收口**：T64–T69 各改同一份 SYSTEM_PROMPT 后通读全文合并去重（只删不增）+ audit 对基线复核成效 |
| ⬜🔒 | T71 | tasks/T71-user-correction-feedback.md | 用户纠正回流食物库（**待拍板 Q1-Q4**，硬依赖 T66 三元组）：改一次终身受益 |
