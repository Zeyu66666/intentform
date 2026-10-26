# Prompt 链归档

官方要求：至少 3 个核心功能迭代的**完整 Prompt 链**，每条链须含「我的提问 + AI 的修改建议 + 我如何引导 AI 修复 Bug 的过程」。
这里的目录就是那条要求的落地形态，评委按目录顺序读即可复现整条演进链路。

## 目录约定

```
docs/prompt-log/
├── _template/summary.md      # 四段式模板，复制后填写
├── P00/summary.md            # 架构约束注入（I0）
│   └── raw-*.md              # 会话原始导出，已脱敏
├── P01/summary.md            # Schema DSL 设计（I1）
├── P02/summary.md            # 流式解析（I2，★录屏）
├── P03/summary.md            # 增量渲染（I3）
├── P04/summary.md            # 提交与判分（I4）
├── P05/summary.md            # 修复环（I6，★录屏）
├── P06/summary.md            # Prompt v1→v3（I6）
├── P07/summary.md            # Patch（I7，★录屏）
├── P08/summary.md            # 安全审计（I8）
└── P09/summary.md            # 设计评审（I9）
```

## 强制规则

1. **四段式**：提问 / AI 修改建议 / 我如何引导 AI 修复 Bug / 结果。少一段就不算归档。
2. **Bug 段不允许编造**：本轮没发生真实 bug 就写"待补"，下轮补上。编造会被评审通过 commit 时间线拆穿。
3. **5 分钟内导出**：会话结束后立刻把原始对话导出成 `raw-<日期>-<主题>.md`，再填 `summary.md`。隔天补记会丢上下文。
4. **双重脱敏（占位符替换，不删段）**：`raw-*.md` 也要过一遍 `node scripts/secret-scan.mjs`。姓名、手机号、学校名、邮箱、本机路径里的用户名，一律用占位符替换（如 `[REDACTED-NAME]`、`[REDACTED-PHONE]`），**不整段删除**——删掉段落会让导出文件失去真实性。替换后在 `summary.md` 末尾记一行「替换了哪几类信息」；没替换也要写「无需替换」。
5. **commit hash 占位必须填实**：`summary.md` 里写的 hash 必须能在 `git log` 里查到，且该 commit 的改动范围与 summary 描述一致。
6. **AI 的建议要写取舍**：采纳了什么、否决了什么、为什么。只写"AI 给了方案我用了"没有留痕价值。

## 与提交的关系

| 标签 | 含义 |
|---|---|
| `[Pxx]` | 该 commit 属于 Prompt 链 Pxx |
| `[AI-TEST]` | AI 生成的测试，或由 AI 测试发现的缺陷修复 |

`commit-msg` 钩子会对 `feat` / `fix` / `test` 强制要求上述标签之一，缺少直接拒绝提交。`chore` / `docs` / `ci` 不强制，但属于某条 Prompt 链时也应带上（本仓库的惯例是带上）。
