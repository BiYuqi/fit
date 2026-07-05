# 一键部署方案：Cloudflare Tunnel + 自定义域名

## 架构

```
iPhone (Xcode 安装)
    │
    │  https://fit-api.refinely.app
    ▼
Cloudflare Tunnel (已有: market-cap-radar)
    │
    │  localhost:9300
    ▼
Mac 后端 (fastify + prisma + postgres)
```

一个脚本拉起全部：DB → 后端 → Tunnel 公网暴露。前端走 Xcode USB 直装。

---

## Step 1: 配 DNS（一次性的，30 秒）

在 Cloudflare Dashboard → 你的域名 `refinely.app` → DNS：

| 类型 | 名称 | 目标 |
|------|------|------|
| CNAME | `fit-api` | `27360821-0661-445d-b247-8ae8b7f8ea8a.cfargotunnel.com` |

（Tunnel UUID 来自 `cloudflared tunnel list` 的输出，已有）

---

## Step 2: 加 Tunnel ingress（一次性的）

编辑 `~/.cloudflared/config.yml`，在现有 ingress 列表里加一条：

```yaml
tunnel: 27360821-0661-445d-b247-8ae8b7f8ea8a
credentials-file: /Users/0xbyte/.cloudflared/27360821-0661-445d-b247-8ae8b7f8ea8a.json

ingress:
  - hostname: radar.refinely.app
    service: http://localhost:9257
  - hostname: radar-api.refinely.app
    service: http://localhost:9256
  # ↓ 新增
  - hostname: fit-api.refinely.app
    service: http://localhost:9300
  # ↑ 新增
  - service: http_status:404
```

然后重启 tunnel。这条 tunnel 由 **market-cap-radar 的 launchd 守护**（`com.market-cap-radar.cloudflared`），fit 不自己起 tunnel，只在共享 config 里登记一个域名。改完 config 重启它：

```bash
launchctl kickstart -k "gui/$(id -u)/com.market-cap-radar.cloudflared"
```

---

## Step 3: 后端跑起来

后端只管 **DB + 服务**，tunnel 交给 Step 2 那条共享守护。有两种跑法：

### 3a. 开机自启（prod，日常自用推荐）

`deploy/` 目录下一套 launchd：

```bash
./deploy/install-launchd.sh     # 首次：装依赖→迁移→build→注册自启并启动
```

- 干什么：注册用户级 LaunchAgent `com.fit`，`RunAtLoad`（登录自启）+ `KeepAlive`（崩了自拉）。
- 每次登录 / 崩溃后由 `deploy/run.sh` 拉起：起 DB 容器 → `prisma migrate deploy` → `node dist/index.js`（**prod**，跑预编译 dist）。
- 前置：Docker Desktop 建议设为开机登录项，否则自启时 daemon 可能没就绪（`run.sh` 有 30s 等待 + KeepAlive 兜底重试）。
- node 走 nvm：`run.sh` 里加载 nvm 的 default 版本，升级 node 不失效。

改完后端代码要上线：

```bash
./deploy/redeploy.sh            # 重新 build + 重启 job，一条命令
```

停用自启：`./deploy/uninstall-launchd.sh`（不动 DB 和 tunnel）。

### 3b. 调试（dev，改后端时用）

要改后端就跑 **`./start.sh ios`**：调试后端起在 **`:9301`**（`tsx watch`，改代码自动重启）+ 模拟器连 9301。它跟 prod 的 9300 **各占一个端口，井水不犯河水**，所以调试时**不用停 prod、不用碰 launchd**。详见下方「调试后端」。

---

## Step 4: 前端环境变量

`frontend/.env` 的 `EXPO_PUBLIC_API_URL` 决定 App 连哪个后端。自用有两种模式，按需二选一（Xcode build 时读取，改完要重装）：

```bash
# frontend/.env

# 模式一 · 局域网直连（同 WiFi，最快，不依赖 tunnel）
EXPO_PUBLIC_API_URL=http://192.168.31.10:9300

# 模式二 · 公网 tunnel（出门/换网络也能用，需 Step 1-2 配好）
# EXPO_PUBLIC_API_URL=https://fit-api.refinely.app
```

> 当前 `.env` 用的是**模式一**（局域网 IP）。想让手机离开家里的 WiFi 也能用，切到模式二后 `npx expo run:ios --device` 重装即可。

---

## 日常使用

```bash
# 后端（自启已装好后，平时啥都不用管）
./deploy/redeploy.sh                       # 改了后端代码 → 一键重新上线
launchctl list | grep com.fit              # 看后端在不在
tail -f .data/launchd.log                  # 看后端日志

# 前端改代码后重新装手机
cd frontend && npx expo run:ios --device   # 改了原生
cd frontend && npx expo start --dev-client # 只改 JS，热更
```

后端自启 + tunnel 常驻：Mac 不关机，出门拿手机打开 App 就能用。

## 端口备忘（两套后端并行）

| 端口 | 谁 | 谁连它 |
|---|---|---|
| `9300` | **prod** 后端（自启常驻，tunnel 转发目标） | 公网 / 真机 |
| `9301` | **dev** 后端（`./start.sh ios` 调试用，热重载） | 模拟器 |
| `5432` | Postgres 容器（两套后端**共用**同一个库） | — |
| `8081` | Expo/Metro dev server（跟后端无关，不冲突） | — |

核心：prod 与 dev 各占一个端口，**互不干扰**——调试不用停 prod、不用碰 launchd。
模拟器跑在 Mac 上，其 `localhost` 即 Mac 的 localhost，所以连 `localhost:9301` 即可。

## 调试后端：一键 `./start.sh ios`

```bash
./start.sh ios
```

一条命令拉起：起 DB（复用 `fit-pg`）→ 调试后端 `:9301`（`npm run dev:local`，`tsx watch` 热重载）→ 模拟器连 `:9301`。
改后端代码**存盘即自动重启**；`Ctrl+C` 收工，prod 的 `:9300` 全程没动。

> - 9301 与 9300 **共用同一个库**（`5432/fit`）。单用户临时调试，接受共库；调试写的数据会进真实库，自己心里有数。
> - tunnel 只转发到 9300，所以**公网 / 真机走的永远是 prod**，不受调试影响。
> - 内联的 `EXPO_PUBLIC_API_URL` 只影响这次模拟器运行，**不动** `frontend/.env`（真机/公网那套照旧）。

### 常用命令速查

| 想干嘛 | 命令 |
|---|---|
| 调试（模拟器 + 9301 后端，热重载） | `./start.sh ios` |
| 看 prod 在不在 | `launchctl list \| grep com.fit` |
| 看 prod 日志 | `tail -f .data/launchd.log` |
| 改完代码上线到 prod | `./deploy/redeploy.sh` |
| 只重启 prod 不重建 | `launchctl kickstart -k gui/$(id -u)/com.fit` |
| 彻底停用自启 | `./deploy/uninstall-launchd.sh` |
