# P35 · Docker 部署评估与镜像配置

- 迭代：部署 · 日期：`2026-11-12` · 涉及模块：根目录、`docs`、`docker`
- 会话导出：本轮未导出原始会话；本文件按实际修改与检查结果整理
- 提交边界：Dockerfile / compose / 文档随后提交

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人的问题：「给我的项目部署一下 docker，你觉得合适吗」 |
| 取舍 | **合适，但只适合单实例**。Docker 的最大价值不是“打包”，而是把 Node 24、pnpm 11.24.0 与 Linux 原生依赖（better-sqlite3 / @node-rs/argon2）钉死——这正好是朋友本地部署最容易漂移的三处。数据用 `intentform-data` volume 持久化；密钥只从宿主环境注入；不做多副本（SQLite 单写者，限流与网页模型设置都在进程内存） |
| 验收案例 | ①Dockerfile 能构建出只含生产依赖与 `web/dist` 的镜像；②`SESSION_SECRET` 缺失时 compose 拒绝启动；③默认 replay 模式无需 Key；④数据目录由 named volume 持久化，容器进程以 node 用户运行；⑤`GET /healthz` 作为健康检查；⑥不会把 `.env`、node_modules、docs/evidence 塞进构建上下文 |
| 停止条件 | 在镜像里写死 API Key；把 SQLite 库放在容器可写层；默认跑多个副本；为了 Docker 引入新的运行时依赖；把 `.env` 自动读取改回服务端默认行为 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 构建 | `Dockerfile` | 三阶段：全量 deps + web build → prod-only deps → runtime。基础镜像 `node:24-bookworm-slim`（glibc，原生预编译包齐全），不选 alpine |
| 运行时依赖 | `Dockerfile` | pnpm isolated 布局下，`server/node_modules`、`packages/schema/node_modules`、`packages/llm/node_modules` 各有一层 symlink；必须一起复制，只拷根 `node_modules` 会在 import 时炸 |
| 进程 | `docker/entrypoint.sh` | 以 root 启动，只对数据目录 `chown`，然后 `gosu node` 降权；应用进程不持有 root |
| 持久化 | `compose.yaml` | 只挂 `intentform-data:/app/data`；SQLite（含配图 BLOB）都在这里 |
| 配置 | `compose.yaml` | `SESSION_SECRET` 用 `${VAR:?}` 强制显式设置；`LLM_MODE` 默认 `replay`；`LLM_API_KEY` 从宿主环境注入，不写进文件 |
| 构建上下文 | `.dockerignore` | 排除 `.git`、node_modules、`data/`、`web/dist`、`docs/`、`.env*`、日志与临时目录；保留 `fixtures/replays/` 供 replay 模式使用 |
| 文档 | `docs/deploy-docker.md`、`README.md` | 最短路径、live 模式、备份、HTTPS/反代、单副本原因、常见问题 |

## 我如何引导 AI 修复问题

1. **只复制根 node_modules 会漏包**。pnpm workspace 的依赖不是全部 hoist 到根：`server` 的
   better-sqlite3/argon2、`schema` 的 zod/katex 在各自包的 `node_modules` 里。镜像必须把
   这三层都拷进去，否则容器启动时才会在 `import` 阶段报找不到模块。
2. **named volume 默认属于 root**。直接 `USER node` 会写不进 SQLite；入口脚本先以 root
   修目录归属，再 `gosu node` 执行 CMD，既不用把应用跑成 root，也不用要求宿主预先 chown。
3. **Compose 会自动读 `.env`**。这和本仓库“服务端不读 `.env`、Key 不落文件”的口径冲突；
   文档明确要求 Key 走宿主环境，并给出 `COMPOSE_DISABLE_ENV_FILE=true` 的用法（Compose
   2.24+）。`compose.yaml` 不写死任何 Key。
4. **本机没有 Docker**。`docker --version` 不存在，无法实际 build；本轮只做了静态检查：
   `compose.yaml` 用 YAML 解析器验证、`entrypoint.sh` 过 `sh -n`、Dockerfile 的 COPY
   路径逐个核对。最终结论必须如实写成“未在本机构建”，不能假装部署成功。

自己否决的：

- **Alpine 基础镜像**：更小，但 musl 预编译包与 glibc 不同，原生依赖风险反而高。
- **在 Dockerfile 里 `pnpm seed`**：会把演示数据打进镜像，且每次重建都重置库。
- **把数据目录放在镜像内**：容器一换就丢；必须 named volume。
- **多副本 + 共享 SQLite 卷**：SQLite 单写者，且限流/网页设置都在进程内存。
- **把 Key 写进 compose.yaml 或 `.env`**：违反仓库的密钥边界。

## 结果

| 检查 | 结果 |
|---|---|
| `docker --version` | **本机未安装 Docker，未实际构建/启动镜像** |
| `compose.yaml` YAML 解析 | 通过（服务、环境、卷、健康检查结构可解析） |
| `sh -n docker/entrypoint.sh` | 通过 |
| `pnpm check` | 未受部署文件影响；最近一次为 92 文件 / 1054 用例全绿 |

**已知边界**：

- 镜像未在本机构建，首次在有 Docker 的机器上执行 `docker compose build` 时仍需观察
  `pnpm install` 与原生包加载；失败先看构建日志。
- 只验证了单实例；多副本需要先换 PostgreSQL 与共享限流存储。
- 未包含 TLS 终止：HTTPS 需要 Caddy/Nginx 等反向代理，并设置 `COOKIE_SECURE=true`、
  `APP_ORIGIN=https://域名`。
- 演示账号 `teacher@example.com / intentform-demo` 是公开的种子数据；生产需替换。
- 备份需要冷备 SQLite 文件或卷快照；容器运行时直接复制库文件不安全。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱或 API Key；compose 中只有变量名与占位符。原始会话未导出，无需额外替换。
