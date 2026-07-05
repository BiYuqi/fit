# 本地数据库托管：Docker vs 原生 Postgres

> 状态：**记录决策与迁移方案，暂不执行**。当前仍用 Docker（`fit-pg` 容器）。
> 关联：`docs/ARCHITECTURE.md §7 / §7.1`（选 Postgres 的地基决策）、`docs/DEPLOY.md`（部署）。

## 背景：为什么当初用 Docker

Docker 是**开发期**的选择，图干净、可弃：

- **一条命令起、删容器即清零**：`docker run` 起个 Postgres，不要了 `docker rm` 删掉，系统不留残渣。开发阶段反复重建/清库方便。
- **不污染系统**：版本、数据目录、进程都封在容器里。
- **环境一致**：`postgres:16` 镜像锁死版本，换机器一样的库。

见 ARCHITECTURE §7.1：「本地 Postgres 用 Docker 起最干净，删容器即清理」。

## 场景变了：从「开发」到「常驻自用」

现在要把后端当 **24 小时常驻服务器**（Mac 常开 + Cloudflare tunnel 暴露，见 DEPLOY.md）。
这时 Docker Desktop 一直挂着就偏重：吃内存（几个 G 级别），还得设成开机自启才能保证 launchd 拉后端时容器已就绪。

**核心**：不是当初选错，是场景从「反复重建的开发」变成了「一直开着的自用服务」。后者原生 Postgres 更贴。

## 选项对比（使用层面）

| 维度 | Docker（现状） | 原生 Postgres（brew） |
|---|---|---|
| 资源占用 | Docker Desktop 重（GB 级） | 轻（几十 MB，`brew services` 常驻） |
| 常驻/自启 | 要 Docker Desktop 登录自启 | `brew services` 天然常驻自启 |
| 推倒整个引擎重来 | `docker rm -f` 最爽 | 需 `dropdb/createdb`，不如删容器干脆 |
| 清库重灌（开发） | `prisma migrate reset` | `prisma migrate reset`（**一样**） |
| 多 PG 版本并行 | 容器随便起多个 | 基本单主版本（自用用不上） |
| 扩展 pg_trgm | 镜像自带 | brew 版自带 contrib（**一样**） |
| 备份/迁移 | `pg_dump` | `pg_dump`（**一样**） |

结论：**使用体验上原生对自用几乎无损**（清库有 `prisma migrate reset` 顶），还更轻、更适合常驻。唯一明显不如 Docker 的是「反复推倒整个 DB 引擎」，但日常开发用不到那种程度。

## 真正的成本：脚本要改一遍

现有脚本围绕 Docker 写死，迁原生需改这些（**这才是迁移工作量，不是使用难度**）：

- `start.sh`：`start_db()` 的 `docker run/start fit-pg`、`docker exec ... pg_isready`、`stop) docker stop fit-pg`
- `deploy/run.sh`：开头那段起 DB 容器 + `pg_isready` 等待
- 建议改法：**原生优先、Docker 可选**——探测原生 Postgres 在不在，在就用；否则回退 Docker。两种都兼容，不锁死。

## 迁移清单（待执行，暂缓）

1. `brew install postgresql@16 && brew services start postgresql@16`
2. `createdb fit`（或按现有 `DATABASE_URL` 的库名）
3. 数据搬家：从容器 `pg_dump` → 导入原生（`pg_dump -h localhost -p 5432 ... | psql ...`，注意容器与原生若都占 5432 需临时错开端口）
4. 改 `backend/.env` 的 `DATABASE_URL` 指向原生实例
5. 改 `start.sh` / `deploy/run.sh` 的起库逻辑（原生优先、Docker 回退）
6. 验证：`prisma migrate deploy` + 起后端 + 打一个真实端点
7. 确认无误后 `docker rm -f fit-pg`，Docker 从此可不开

## 什么时候值得做

- 觉得 Docker Desktop 常驻太重 / 不想让它开机自启时。
- 短期不做也完全能跑：Docker Desktop 设登录自启即可，功能上没差别。
