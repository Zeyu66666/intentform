# P13 · 生产构建 CSP 与生产闭环

- 迭代：省赛 `R-08` · 日期：`2026-10-30` · 涉及模块：`server`、`scripts`、`README.md`
- 会话导出：本轮未导出原始会话；本文件只记录可由仓库命令复核的实现与验收事实

## 开工前写清的四件事

| 项 | 内容 |
|---|---|
| 目标 | 只在生产构建响应上下发 CSP；`script-src 'self'`，KaTeX 所需内联样式用 `style-src-attr 'unsafe-inline'`，不放开 `script-src`；E2E 跑生产构建并断言响应头 |
| 允许修改范围 | `server/src/{security,security.test,main}.ts`；`scripts/browser-closed-loop.mjs`；`README.md`；本留痕 |
| 验收案例 | ①生产页面与静态资源由同一个 Node 服务提供；②生产 HTML 带严格 CSP；③`script-src` 不含 `unsafe-inline`；④开发 Vite 不下发该 CSP；⑤资产路径不能越出 `web/dist`；⑥生产闭环脚本先构建再启动 |
| 停止条件 | 放开 `script-src 'unsafe-inline'`、用第三方 CDN 或依赖，或让开发服务器假装成生产构建 |

## 实现

1. `server/src/security.ts` 定义 `PRODUCTION_CONTENT_SECURITY_POLICY` 与生产环境判定。
2. `main.ts` 在 `NODE_ENV=production` 时统一下发 CSP、`X-Content-Type-Options` 与 `Referrer-Policy`。
3. 生产同源模式下由 Node 托管 `WEB_INDEX_HTML` 指向的 SPA 壳和 `/assets/*`，带路径边界检查；开发期仍走 Vite。
4. 浏览器闭环改为先执行生产前端构建，再启动生产 Node 服务，并在 Chrome 之前断言首页 CSP 响应头。

## 验证

| 命令 | 结果 |
|---|---|
| `pnpm.cmd check` | 通过；67 文件 / 783 用例 |
| `node scripts/verify.mjs` | VC1–VC10 全过 |
| `node scripts/browser-closed-loop.mjs` | 生产构建与服务启动成功；Chrome/CDP 仍在 `Page.enable` 前断开，未生成新截图 |

## 已知边界

- CSP 由同源 Node 生产服务下发；反向代理或静态托管层的响应头配置不在仓库内。
- 浏览器闭环脚本已从 Vite dev server 切到生产构建，但本轮受本机 Chrome/CDP 环境阻断，未形成新的浏览器截图证据。
