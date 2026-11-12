# syntax=docker/dockerfile:1.7
#
# 意卷 IntentForm · 生产镜像
#
# 为什么用 Node 24：服务端直接运行 TypeScript（`node --experimental-strip-types`），
# 且 `packageManager` 固定在 pnpm@11.24.0。这两件事在宿主机上很容易版本漂移，
# Docker 的价值正是把它们钉死。
#
# 三阶段：
#   1. deps/build：装全量依赖、构建 `web/dist`；
#   2. prod-deps：只装生产依赖，避免把 vite/vitest 带进镜像；
#   3. runtime：不含 pnpm，只留服务器、两个 workspace 包、生产 node_modules 与前端产物。
#
# 原生依赖（better-sqlite3 / @node-rs/argon2）都带 Linux 预编译包；基础镜像用
# bookworm（glibc）而不是 alpine，避免 musl 预编译缺失时触发 node-gyp。

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g pnpm@11.24.0 && npm cache clean --force
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/llm/package.json packages/llm/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages ./packages
COPY server ./server
COPY web ./web
COPY fixtures ./fixtures
RUN pnpm --filter @intentform/web build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/llm/package.json packages/llm/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
# gosu 只做一件事：入口脚本以 root 修好数据目录归属后，立刻降权到 node 运行。
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/app/data/intentform.db \
    WEB_INDEX_HTML=/app/web/dist/index.html

WORKDIR /app

# pnpm 的 isolated node_modules：每个 workspace 包各有一层指向虚拟 store 的 symlink。
# 只拷根目录会丢掉 server 的 better-sqlite3 / argon2 与 schema 的 zod / katex，
# 运行时就会在 import 阶段炸掉。
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=prod-deps /app/packages/schema/node_modules ./packages/schema/node_modules
COPY --from=prod-deps /app/packages/llm/node_modules ./packages/llm/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema ./packages/schema
COPY packages/llm ./packages/llm
COPY server ./server
# replay 模式从仓库根读 fixtures；live/mock 不用它，但不该让镜像“换个模式就崩”。
COPY fixtures ./fixtures
COPY web/package.json ./web/package.json
COPY --from=build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/intentform-entrypoint

RUN chmod +x /usr/local/bin/intentform-entrypoint \
    && mkdir -p /app/data \
    && chown -R node:node /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["intentform-entrypoint"]
CMD ["node", "--experimental-strip-types", "server/src/main.ts"]
