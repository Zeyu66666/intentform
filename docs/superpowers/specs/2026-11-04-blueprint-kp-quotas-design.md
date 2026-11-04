# 蓝图「知识点 × 题型」配额 · 设计（2026-11-04）

## 意图

教师需要在确认蓝图时钉住具体组合，而不只是给出两份互不相干的汇总：
「立体几何出 1 道单选 + 1 道简答」。现有 `typeMix` 只说每种题型各几道，
`knowledgePoints` 只说整卷覆盖哪些知识点；两者之间没有「谁配谁」的关系。

## 目标

- 在 `FormBlueprint` 上增加可选的 `quotas`：每条 `{ knowledgePoint, type, count }`。
- 教师可在蓝图卡里增删改配额，知识点用中文名选择，不暴露内部 id。
- 配额随蓝图 JSON 一起进入生成请求，并在蓝图对照里检查是否兑现。
- 旧蓝图（没有 `quotas`）继续合法，回放 fixture 与 prompt 版本不变。

## 非目标

- 不要求每道题都归入某个知识点；未指定的题仍按 `typeMix` 自由分配。
- 不新增题型，不改分值规则，不改学生端。
- 不改 `plan.v1` / `generate.v3` 的提示词正文；配额作为蓝图数据的一部分提交。

## 契约

```ts
// 量表没有 knowledgePoint 字段，配额对它永远无法兑现，所以只允许五种题型。
type QuotaType = "single" | "multi" | "fill" | "number" | "short";

interface BlueprintQuota {
  readonly knowledgePoint: string; // 必须存在于 knowledgePoints[].id
  readonly type: QuotaType;
  readonly count: number; // 1..LIMITS.fieldsMax
}

interface FormBlueprint {
  // ...现有字段
  readonly quotas?: readonly BlueprintQuota[];
}
```

校验（`blueprintSchema.superRefine`）：

1. `knowledgePoint` 必须是已声明知识点的 id。
2. 同一 `(knowledgePoint, type)` 不允许重复。
3. 每种题型的配额之和不得超过 `typeMix[type]`。
4. 配额总题数不得超过 `totalCount`（由 3 自然保证，仍显式检查）。
5. 问卷不产生配额；界面隐藏入口，校验不额外拒绝旧问卷蓝图。

## 编辑行为（`blueprint-edit.ts`）

- `addQuota`：优先选第一个「还有余量」的知识点与题型，初始 `count = 1`；无余量则不变。
- 改知识点 / 题型 / 题量都走纯函数，题量夹在 `1..该题型剩余容量`。
- 改总题型分布或章节题量后，若某题型容量变小，按行尾顺序裁剪该题型的配额，
  保持「配额 ≤ 题型分布」永不破。
- 删除知识点时，连带删除引用它的配额。
- 修改知识点 id 时同步改写配额引用（保留现有函数的一致性）。

## 界面（`BlueprintCard`）

- 在「知识点」之后增加「按知识点指定题目」区块，仅判分卷显示。
- 每条一行：知识点下拉（中文名）、题型下拉（非分节）、题量数字、删除。
- 「加指定」按钮在没有知识点或没有剩余容量时禁用，并给出原因。
- 现有「题型分布」仍是总盘；配额只从对应题型里「占位」。

## 生成与对照

- 蓝图 JSON 原样进入生成请求；现有提示已声明蓝图是硬约束。
- `compareWithBlueprint` 增加配额对照：按 `(knowledgePoint, type)` 统计成品，
  返回 `quotaMismatches`；任何一条不等于计划值都让 `isExact = false`。
- 时间线摘要只需沿用「结构完全对上 / 有偏差」，不新增协议事件。

## 兼容与边界

- `quotas` 可选；旧计划响应、旧 fixture、手工构造的蓝图都不需要补字段。
- 不递增 prompt 版本：本轮不改提示词正文；配额靠蓝图 JSON 传递。
  若真实上游证明模型不遵守配额，下一轮再升 `generate.v4` 并重录 fixture，
  不能拿旧录像冒充新提示词。
- 模型是否兑现配额只能事后对照；本轮不把配额做成整表门禁，避免把「结构偏差」
  升级成「无法生成」。

## 验证

- `packages/schema/src/blueprint.test.ts`：合法配额、未知知识点、重复组合、超出题型容量。
- `packages/schema/src/blueprint.test.ts`：配额不匹配时 `isExact = false` 且列出差异。
- `web/src/panels/blueprint-edit.test.ts`：增删改、裁剪、删除知识点连带清理。
- `web/src/panels/BlueprintCard.test.ts`：只显示中文名、无 `kp_` 输入。
- `scripts/browser-closed-loop.mjs`：生成前加两条配额并断言 DOM；随后清理，保持后续流程不变。
