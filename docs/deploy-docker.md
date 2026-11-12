# Docker 部署

这套镜像把三件最容易漂移的东西钉死：**Node 24**、**pnpm 11.24.0** 与 Linux 原生依赖
（better-sqlite3 / @node-rs/argon2 的预编译包）。适合送给朋友在自己机器或一台小 VPS 上跑，
不适合多副本横向扩展。

> 本仓库的工作环境没有安装 Docker，因此这份配置**没有在本机实际 build 过**；命令与
> 边界都按仓库的真实启动方式写。第一次部署请按下面的顺序执行，失败时先看
> `docker compose logs -f app`。

## 前置

- Docker Engine 24+（或 Docker Desktop）
- 2 GiB 内存、1 GiB 磁盘（镜像 + SQLite 库；题目配图存库，按实际使用增长）
- 一个 x86_64 或 arm64 主机；两种架构都有预编译包

## 最短路径（replay 模式，不需要任何 Key）

```bash
# 1. 生成 session 密钥（不要写进仓库里的文件）
export SESSION_SECRET="$(openssl rand -hex 32)"

# 2. 构建并启动
docker compose build
docker compose up -d

# 3. 看启动日志（应看到 LLM_MODE=replay 与 db 路径）
docker compose logs -f app

# 4. 打开 http://<主机>:8787
```

默认 `LLM_MODE=replay`：生成走 `fixtures/replays/`，零外部调用、不花钱，适合先确认
页面、登录、学生短链、打印/Word/配图都能用。

演示账号：`teacher@example.com / intentform-demo`。**生产不要继续用它**——这个账号和
密码写在 `server/src/seed.ts` 里，是公开的演示数据。要换账号，先在宿主机执行
`pnpm seed` 之外的方式创建教师，或只在受控内网演示时保留。

## live 模式（真实模型）

Key **只从启动命令的环境变量传入**，不要写进 `compose.yaml`，也不要写进 `.env`：

```bash
export LLM_MODE=live
export LLM_API_KEY='sk-...'
docker compose up -d --build
docker compose logs -f app   # 启动日志会脱敏，不应出现 Key
```

Compose 默认会读取项目目录下的 `.env` 做变量插值。若机器上存在旧的 `.env`，建议启动时
显式禁用：

```bash
COMPOSE_DISABLE_ENV_FILE=true docker compose up -d
```

（Compose 2.24+ 支持该变量；更老版本请直接删除 `.env`，不要把 Key 放进去。）

## 数据与备份

唯一需要持久化的是 `intentform-data` volume 里的 SQLite 库：

```bash
# 停服备份（SQLite 单文件，冷备最稳）
docker compose stop app
docker run --rm \
  -v intentform-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine sh -c 'tar czf /backup/intentform-$(date +%F-%H%M).tgz -C /data .'
docker compose start app
```

恢复时把 tar 解回 volume，再启动。**不要**在容器运行时直接 `cp` 数据库文件，SQLite
可能正持有页缓存。

## HTTPS 与反向代理

应用只监听容器内 `8787`，TLS 交给 Caddy/Nginx：

1. 代理到 `http://127.0.0.1:8787`；
2. 设置 `COOKIE_SECURE=true`；
3. 设置 `APP_ORIGIN=https://你的域名`（生产同源也可以留空让服务端按 Host 推断，
   但经代理改写 Host 时显式配置更稳）；
4. 重新 `docker compose up -d`。

CSP、`x-content-type-options`、`referrer-policy` 由应用在 `NODE_ENV=production` 下自己下发，
不需要在代理层重复。

## 为什么只跑一个副本

- SQLite 是单写者；两个容器同时写同一个卷会互相锁表。
- 限流计数、网页「模型设置」的临时改动都在进程内存里；多副本会各自为政。
- 需要横向扩展时，先换 PostgreSQL 与共享限流存储，再谈副本数。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即退出，日志提示 `SESSION_SECRET` | compose 的 `:?` 拦截了空值 | 先在宿主环境 `export SESSION_SECRET=...` |
| `login` 后立刻掉线 | `COOKIE_SECURE=true` 但实际是 http | 本地/http 代理下设为 `false` |
| 首页 404 JSON | `WEB_INDEX_HTML` 没指到 `web/dist/index.html` | 镜像已默认设置；自定义时检查路径 |
| live 模式启动报缺 Key | `LLM_MODE=live` 但 `LLM_API_KEY` 为空 | 通过宿主环境传 Key，不要改镜像 |
| 学生短链 404 | 表单没发布，或已被逻辑删除 | 在编辑器发布；删除是墓碑，不会恢复 |
| 配图不显示 | 草稿表单的图只给 owner；学生访问已发布版 | 发布后再打开学生短链 |
| 数据重启后消失 | 没挂 `intentform-data` volume | 用仓库自带的 `compose.yaml`，不要裸 `docker run` |
| arm64 构建慢/失败 | 用了 alpine 或强制 amd64 仿真 | 用默认 `node:24-bookworm-slim`，不要指定 `platform` |

## 镜像里有什么

- 运行：Node 24 + `server/src/main.ts`（TypeScript 由 Node 原生去类型，不经过 tsc）
- 前端：`web/dist`（构建阶段生成，运行阶段不装 vite）
- 依赖：只装生产依赖；`better-sqlite3` 与 `@node-rs/argon2` 使用 Linux 预编译包
- 进程：入口脚本以 root 修数据目录归属后，`gosu node` 降权运行
- 健康检查：容器内 `GET /healthz`
