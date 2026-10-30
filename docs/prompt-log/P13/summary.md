# P13 · 生产构建 CSP 与生产闭环

- 迭代：省赛 `R-08` · 日期：`2026-10-30` · 涉及模块：`server`、`scripts`、`web`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理，未把失败的浏览器启动写成成功证据
- 提交边界：R-08 功能本轮 1 个 commit：`2cd234c`；浏览器/CDP 修复、生产截图与证据索引随后单独提交为 `782ba70`。因此 P13 相关最终有 2 个 commit，功能与证据分开。

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 只在生产构建响应下发 CSP：`script-src 'self'`；KaTeX 所需内联样式用 `style-src-attr 'unsafe-inline'` 单独放行；不放开 `script-src`；浏览器闭环改跑生产构建并断言响应头 |
| 允许修改范围 | `server/src/{security,security.test,main}.ts`；`scripts/browser-closed-loop.mjs`；README、AGENTS、证据说明与本留痕 |
| 验收案例 | ①生产首页由 Node 服务提供；②`/assets/*` 能加载构建资源；③生产 HTML 带 CSP；④脚本策略没有 `unsafe-inline`；⑤开发 Vite 不被生产 CSP 改动；⑥资源路径不能越出构建目录 |
| 停止条件 | 放开 `script-src 'unsafe-inline'`、引入 CDN/新依赖、让开发服务器冒充生产构建，或只改响应头而没有生产闭环断言 |

## 提问与裁定

本轮没有新增用户选项裁定；执行依据是《计划-v3.1》§2.1.1 第 5 条、`AGENTS.md` §5 的 CSP 红线，以及 P11 后已有的 `WEB_INDEX_HTML` 生产同源托管入口。

沿用的硬约束：Vite 开发服务器不加严格 CSP；生产服务必须同源提供页面和 `/assets/*`；不安装依赖；浏览器证据必须区分“生产构建已断言”和“Chrome 真正完成闭环”。

## AI 修改建议

采纳的：

1. 增加 `server/src/security.ts`，集中定义生产 CSP 和 `NODE_ENV=production` 判定。
2. `main.ts` 在生产响应上统一设置 CSP、`X-Content-Type-Options`、`Referrer-Policy`。
3. 生产同源模式由 Node 托管 `WEB_INDEX_HTML` 指向的 `index.html` 和 `/assets/*`，并对解析后的路径做边界检查。
4. 浏览器闭环先运行生产前端构建，再启动生产 Node 服务；连接 Chrome 前先用 HTTP 断言 CSP。

我自己否决的：

- 直接在 Vite 配置里给开发服务器加 CSP：计划要求的是生产构建，开发 HMR 不应被当作生产证据。
- 把 CSP 交给浏览器脚本拼接或 HTML meta 标签：验收项是响应头，必须由服务端真实下发。
- 用 `script-src 'unsafe-inline'` 解决 KaTeX 样式问题：脚本和样式是两个权限面，只放行 `style-src-attr 'unsafe-inline'`。
- 继续保留双端口 Vite + API 的浏览器闭环：那只能证明开发代理链路，不能证明生产同源构建。

## 我如何引导 AI 修复问题

本轮先后遇到并修正了两处实现问题：

1. **Windows 下直接 `spawn("pnpm.cmd", ...)` 返回 `EINVAL`**。处理方式是 Windows 显式调用 `ComSpec`，以 `cmd /d /s /c pnpm.cmd --filter @intentform/web build` 执行；随后构建成功，并移除了初版 `shell:true` 的弃用警告。
2. **生产静态托管完成后闭环脚本仍残留 Vite 端口变量**。处理方式是收敛为单一 Node 来源，合并 `webBase` 与 API 来源，去掉 `spawnVite`、`VITE_ENTRY` 和 `webPort`，端口摘要改为 `app`。

没有把 Chrome/CDP 的断开“修”成假通过：生产构建和服务启动成功后，Chrome 仍在 `Page.enable` 前断开，因此本轮没有新的截图证据。

## 结果

省赛 R-08 收口。计划 §2.1.1 第 5 条逐项对应：

| 要求 | 落点 | 证据 |
|---|---|---|
| 生产响应下发 CSP | `PRODUCTION_CONTENT_SECURITY_POLICY`，仅 `NODE_ENV=production` 时由 `main.ts` 设置 | `security.test.ts`；生产首页 HTTP 断言 |
| `script-src 'self'` | CSP 固定包含 `script-src 'self'`，不包含 `script-src 'unsafe-inline'` | `security.test.ts`；浏览器脚本启动前断言 |
| KaTeX 内联样式 | 单独使用 `style-src-attr 'unsafe-inline'`，没有扩大脚本权限 | `security.test.ts`；浏览器脚本启动前断言 |
| 生产构建闭环 | 脚本先 `@intentform/web build`，再由 Node 同源托管 `index.html` 与 `/assets/*` | `browser-closed-loop.mjs`；生产构建实跑成功 |
| 资源边界 | 解析资源路径后必须位于 `WEB_INDEX_HTML` 所在目录；编码路径穿越返回 404 | `security.test.ts` |

真实数字（本轮实测）：

| 命令 | 结果 |
|---|---|
| `pnpm.cmd install --frozen-lockfile` | Already up to date，完成 |
| `pnpm.cmd build:web` | 生产构建成功；Vite 5.4.11，97 modules transformed |
| `pnpm.cmd check` | **67 文件 / 783 用例全绿**；lint、typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC10 全过（10/10）** |
| `node scripts/browser-closed-loop.mjs` | **9 步全绿 / 14 张截图**；生产构建、CSP 响应头与完整浏览器链路均通过 |
| `node scripts/secret-scan.mjs` | 工作区扫描 0 命中 |
| `node scripts/secret-scan.mjs --history` | 全历史扫描 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `2cd234c` | `feat(server): enforce production CSP and serve build [P13]` | R-08 功能实现：CSP、生产静态托管、浏览器脚本切换、测试与文档 |
| `782ba70` | `test(scripts): prove production browser loop with CSP [P13]` | Chrome 临时 profile 加 `--no-sandbox`；生产闭环 9 步全绿、14 张截图与证据索引更新 |

**已知边界**（不写成能力）：

- CSP 由仓库内 Node 生产同源服务下发；如果最终部署前面还有反向代理或独立静态托管层，那一层仍需单独确认响应头。
- 生产构建和首页 CSP HTTP 断言已实跑；受限 Windows 环境下 Chrome 临时 profile 需要 `--no-sandbox`，修复后 9 步全绿并覆盖截图。
- `style-src-attr 'unsafe-inline'` 是为 KaTeX/渲染所需的内联样式属性单独放行，不代表允许脚本内联。
