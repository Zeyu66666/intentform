# P39 · 评审建议 #9：前端 bundle 拆包

- 迭代：评审报告建议项 #9
- 日期：2026-11-12
- 涉及模块：`web/vite.config.ts`

## 我的提问

继续处理建议项，一个一个完成。当前项是前端 production bundle 超过 500 kB，要求小改、不换技术栈、不影响现有流式和公式渲染。

## AI 的修改建议

在 Vite 的 Rollup 输出配置中把 `katex` 放到独立命名 chunk。保留现有同步 `renderToString` 调用，不做动态 import，避免改变公式首次渲染时序和交互语义。

## 我如何引导 AI 修复 Bug

先比较改动前后的真实 build 输出，再跑 KaTeX 渲染测试和 typecheck；只有主入口降到 500 kB 以下且公式测试仍全绿，才接受这次拆包。没有为了消除警告而提高 `chunkSizeWarningLimit`，因为那只是隐藏问题。

## 结果

- `web/vite.config.ts` 新增 `rollupOptions.output.manualChunks.katex`。
- 主入口：`688.55 kB → 426.78 kB`，低于 Vite 500 kB 警告线。
- 独立 KaTeX chunk：`261.01 kB`，gzip `77.05 kB`。
- `pnpm build:web` 无 bundle 警告；`pnpm typecheck` 通过；KaTeX/FieldRegistry 测试 18/18 通过。
