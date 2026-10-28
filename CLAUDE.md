@AGENTS.md

# Claude Code 入口桥

本文件存在的唯一理由：Claude Code 会自动读取仓库根的 `CLAUDE.md`，但不会主动读 `AGENTS.md`。
上面的 `@AGENTS.md` 是导入指令，把约束正文导入到本文件，**不复制**——只有一份事实来源，改约束只改 `AGENTS.md`。

其他 AI 工具（Cursor / Copilot / 各类 CLI agent）如果不是通过 `CLAUDE.md` 读取，直接让它读 `AGENTS.md`。

读完之后按 `AGENTS.md` 的规矩干活：先类型契约再实现、禁用库清单不许碰、提交数量由真实模块边界决定（不设配额）且每个 commit 单独过 `pnpm typecheck`、做不到就说做不到。
