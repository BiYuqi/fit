# DESIGN_SPEC — UI 行为规格

> 视觉高保真稿已由 Claude Design 产出（Onboarding 七步、Chat 全卡片、Today/History/Settings、浅/深两套）。本文件是给开发的**行为规格**：结构、组件、状态、交互。

## 0. 设计接入方式（重要）

设计是本项目的**视觉事实源**，但它导出的是 `.dc.html`（网页），而我们的前端是 **Expo React Native**。两者不是同一种代码。

**铁规则：用 claude_design MCP 导入设计，作为像素参照，在 RN 中重建。绝不把 `.dc.html` 当成品直接实现或套用——那会把 App 做成网页，偏离 Expo 路线。**

- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`
- 文件：`AI 减脂记录 App.dc.html`

**落到任务**：
- T13 = 接入总入口：导入设计 → 抽取 token（配色/圆角/模糊/字号/浅深）→ 建 NativeWind 主题 + 四 Tab 骨架。
- T15–T19 = 逐屏对照设计在 RN 重建（Onboarding/Chat/Today/History/Settings）。
- 设计已就绪，前端可不等后端：先按设计搭静态屏壳，后端通了(T12)再接真接口。

## 1. 视觉基调
iOS 26 Liquid Glass / Apple Intelligence：毛玻璃卡片、柔和半透明层次、无强对比色、圆角柔和、留白充足。**浅色 + 深色**两套。底部 Tab：Chat / Today / History / Settings，Chat 为默认主页。

### 1.9 登录 / 注册（Onboarding 之前）

首屏未登录时进入。账号 + 密码两字段，登录/注册切换；复用全局 Liquid Glass 主题（毛玻璃卡片、浅深两套）。

注册：account + password，account 重复时报“已被占用”。成功后进入 Onboarding。
登录：account + password，错误提示凭据有误。成功后：onboarded=false 进 Onboarding，否则进 Chat。
调 POST /auth/register、POST /auth/login（见 API_SPEC）。

## 2. Onboarding（首次必经，7 步，带进度）
性别 → 年龄 → 身高+体重 → 目标体重 → 活动水平(5档，每档一句说明) → 目标节奏/缺口(温和≈-250 / 标准≈-420 / 激进≈-600，可自定义) → 算好结果欢迎页(展示 TDEE / 每日缺口 / 目标摄入 / 三大营养素目标，按钮"开始记录")。完成调 `PUT /user/profile`。

## 3. Chat（核心页）
**结构**：顶部标题 + "今日已记 X kcal · 在线" + 右上**日期线程选择器(今天 ▼)**；中部消息流；底部 `[+附件] [输入框] [语音] [发送]`。

**消息/卡片类型**（对应 chat_message.kind）：
- 用户文本气泡（role=user, text）
- AI 反馈卡 record_card：食物名+餐次+份数+总kcal，下方蛋白/脂肪/碳水
- 份量选择卡 portion_card：`小份≈180g·约430kcal / 中份≈250g·约590kcal / 大份≈330g·约780kcal / 自定义克数`
- 候选食物卡 candidate_card：`[煎饼果子] [煎饼+油条] [其他]`
- 追问卡 clarify_card：`是不是：[火锅] [外卖混合] [其他描述]`
- 查询回答卡 query_card：如"今天还可以吃 720 kcal" + 剩余额度进度条 + 一句建议
- 运动卡 exercise_card：如"已记录跑步 5km，消耗约 320 kcal"
- 语音录制态：波形 + 时长 + `[取消] [完成并发送]`
- 加号附件菜单：相机 / 照片 / 文件（v1 可仅占位）

**关键交互态**：
- 高置信 → 直接出 record_card。
- 中/低置信 → 出 portion/candidate/clarify 卡；用户点选后该卡**替换为确认后的 record_card**。
- 空状态（当天还没记）→ 友好引导（如"早上好，今天吃了什么？"），不是全白。

**聊天持久化显示行为**：
- 进页面先读本地 SQLite 缓存秒显示，再用 `GET /chat/messages?date=` 同步。
- 顶部线程选择器用 `GET /chat/dates` 列出有对话的日期，默认今天；选别的日期加载那天的线程。
- 卡片新鲜度：**查询类卡片冻结**（显示当时答案）；**记录类卡片绑 record_id**，底层记录被改/删时显示更新或"已删除"。

## 4. Today
毛玻璃卡片：环形完成度(如62%) + **今日缺口(视觉重点，如 -420 kcal)** + 摄入/目标；营养素区(蛋白/脂肪/碳水 已摄入/目标，进度条)；底部一行均衡提示(如"今天蔬菜偏少…")。数据来自 `GET /daily/today`。

## 5. History
顶部 日/周/月 切换；趋势卡(本周/本月平均缺口 + 折线 + "达标 5/7 天"徽标)；下方按日期+餐次分组的记录列表(早/午/晚/加餐/运动，各带 kcal)。数据来自 `GET /daily/range`。

## 6. Settings
顶部一卡实时显示 每日目标摄入 / TDEE / 缺口；身体数据组(身高/体重/年龄/性别/活动水平)；目标组(目标体重/目标类型/每日缺口滑杆)。改动即调 `PUT /user/profile` 并实时刷新顶部数字。底部："清除本地缓存"(只清本地镜像，见 ARCHITECTURE §5)。

## 7. 通用状态
每个数据视图都要有 loading / 空 / 错误 三态；网络失败可读本地缓存并提示离线；记录失败给重试。
