# 蓝图「知识点 × 题型」配额 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让教师在蓝图里钉住「某知识点出几道某题型」，例如立体几何 1 道单选 + 1 道简答。

**Architecture:** 在 `FormBlueprint` 增加可选 `quotas` 数组，作为 `typeMix` 与 `knowledgePoints` 之间的部分分配；配额只占位、不改总数。纯函数负责编辑与裁剪，蓝图卡渲染编辑行，生成请求原样携带蓝图，对照函数报告未兑现的配额。

**Tech Stack:** TypeScript strict、Zod、React 18、Vitest、现有 CDP 浏览器闭环。

**Spec:** `docs/superpowers/specs/2026-11-04-blueprint-kp-quotas-design.md`

## Global Constraints

- 不改 `plan.v1` / `generate.v3` 提示词正文，不重录 fixture。
- `FormBlueprint.quotas` 可选；旧蓝图、旧回放继续合法。
- 知识点在界面上只显示中文名；内部 id 只能出现在 `value`，不能作为可见文本。
- 配额必须满足：知识点存在、同一「知识点 + 题型」不重复、每题型配额和 ≤ `typeMix`、总配额 ≤ `totalCount`。
- 每个 commit 单独通过 `pnpm typecheck`；feat/fix/test 带 `[P23]`。
- 不新增依赖，不引入图表库。

## Review Focus

- 删除知识点时残留配额：预期所有引用它的配额一起消失，蓝图仍能确认。
- 把某题型总数调小到低于已有配额：预期配额被裁剪而不是蓝图变非法、确认按钮突然变灰。
- 配额题量改成 0 或负数：预期被夹到 1，且不超过该题型剩余容量。
- 没有知识点时点「加指定」：预期按钮禁用并说明原因，不产生非法蓝图。
- 浏览器里新增配额后继续生成：预期后续流程不受编辑器演示影响。

---

### Task 1: schema 配额契约、校验与对照

**Files:**
- Modify: `packages/schema/src/blueprint.ts`
- Test: `packages/schema/src/blueprint.test.ts`

**Interfaces:**
- Produces: `BlueprintQuota { knowledgePoint: string; type: Exclude<FieldType, "section">; count: number }`
- Produces: `FormBlueprint.quotas?: readonly BlueprintQuota[]`
- Produces: `BlueprintDeviation.quotaMismatches: readonly BlueprintQuotaMismatch[]`
- Produces: `BlueprintQuotaMismatch { knowledgePoint: string; type: QuotaType; planned: number; actual: number }`

- [ ] **Step 1: Write failing schema tests**

Add to `blueprint.test.ts`:

```ts
it("接受知识点 + 题型的配额，并保留可选缺省", () => {
  const withQuotas = parseBlueprint({ ...validBlueprint, quotas: [{ knowledgePoint: "kp_open", type: "short", count: 1 }] });
  expect(withQuotas.ok).toBe(true);
  const without = parseBlueprint(validBlueprint);
  expect(without.ok).toBe(true);
  if (without.ok) expect(without.blueprint.quotas).toBeUndefined();
});

it("拒绝不存在的知识点、重复组合和超出题型容量的配额", () => {
  expect(parseBlueprint({ ...validBlueprint, quotas: [{ knowledgePoint: "kp_missing", type: "single", count: 1 }] }).ok).toBe(false);
  expect(parseBlueprint({ ...validBlueprint, quotas: [
    { knowledgePoint: "kp_open", type: "single", count: 1 },
    { knowledgePoint: "kp_open", type: "single", count: 1 },
  ] }).ok).toBe(false);
  expect(parseBlueprint({ ...validBlueprint, quotas: [{ knowledgePoint: "kp_open", type: "short", count: 99 }] }).ok).toBe(false);
});

it("配额未兑现时 isExact 为 false 并列出差异", () => {
  const blueprint = { ...baseBlueprint, quotas: [{ knowledgePoint: "kp_open", type: "short", count: 1 }] } as FormBlueprint;
  const deviation = compareWithBlueprint(blueprint, {
    items: [item({ type: "single", knowledgePoint: "kp_open" })],
    totalScore: 5,
    objectives: [{ id: "kp_open", name: "开口方向" }],
  });
  expect(deviation.isExact).toBe(false);
  expect(deviation.quotaMismatches).toEqual([{ knowledgePoint: "kp_open", type: "short", planned: 1, actual: 0 }]);
});
```

Use the file's existing blueprint/item fixtures; do not invent a second fixture style.

- [ ] **Step 2: Run the schema test and confirm the new cases fail**

Run: `pnpm vitest run packages/schema/src/blueprint.test.ts`
Expected: FAIL on missing `quotas` / `quotaMismatches`.

- [ ] **Step 3: Implement the contract and validation**

In `blueprint.ts`:

- Export `type QuotaType = Exclude<FieldType, "section">` and `interface BlueprintQuota`.
- Add `quotas: readonly BlueprintQuota[]` optional property to `FormBlueprint`.
- Add `quotaSchema` with `knowledgePoint` id regex, `type: z.enum(["single","multi","fill","number","short","scale"])`, `count: z.number().int().min(1).max(LIMITS.fieldsMax)`; attach `quotas: z.array(quotaSchema).max(LIMITS.fieldsMax).optional()`.
- In `superRefine`, check unknown id, duplicate `(knowledgePoint,type)`, per-type sum > `typeMix[type]`, and total > `totalCount`; add issues under path `["quotas", index]` with Chinese messages.
- Add `quotaMismatches` to `BlueprintDeviation`; count actual `(knowledgePoint,type)` pairs from non-section items and compare every quota. Include `quotaMismatches.length === 0` in `isExact`.

- [ ] **Step 4: Run schema tests and typecheck**

Run: `pnpm vitest run packages/schema/src/blueprint.test.ts && pnpm --filter @intentform/schema typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/blueprint.ts packages/schema/src/blueprint.test.ts
git commit -m "feat(schema): 蓝图知识点题型配额与对照 [P23]"
```

---

### Task 2: 蓝图编辑纯函数

**Files:**
- Modify: `web/src/panels/blueprint-edit.ts`
- Test: `web/src/panels/blueprint-edit.test.ts`

**Interfaces:**
- Consumes: `BlueprintQuota`, `FormBlueprint` from Task 1.
- Produces: `addQuota(blueprint): FormBlueprint`
- Produces: `removeQuota(blueprint, index): FormBlueprint`
- Produces: `withQuotaKnowledgePoint(blueprint, index, knowledgePoint): FormBlueprint`
- Produces: `withQuotaType(blueprint, index, type: FieldType): FormBlueprint`
- Produces: `withQuotaCount(blueprint, index, value: number): FormBlueprint`
- Produces: `quotaRemaining(blueprint, type, exceptIndex = -1): number`

- [ ] **Step 1: Write failing editor tests**

Add cases that call `expectValid` after every mutation:

```ts
it("加配额只占位，不加题量", () => {
  const next = addQuota(baseBlueprint);
  expect(next.quotas).toEqual([{ knowledgePoint: "kp_open", type: "single", count: 1 }]);
  expect(sumTypes(next)).toBe(next.totalCount);
  expectValid(next);
});

it("题量夹在 1..该题型剩余容量，换题型同样裁剪", () => {
  const one = addQuota(baseBlueprint);
  const bigger = withQuotaCount(one, 0, 99);
  expect(bigger.quotas?.[0]?.count).toBe(baseBlueprint.typeMix.single ?? 0);
  const changed = withQuotaType(bigger, 0, "short");
  expect(changed.quotas?.[0]?.type).toBe("short");
  expectValid(changed);
});

it("题型总数调小会裁剪配额而不是把蓝图改成非法", () => {
  const withShort = withQuotaCount(addQuota(baseBlueprint), 0, 2);
  const shrunk = withTypeCount(withShort, "single", 0);
  expect((shrunk.quotas ?? []).every((quota) => quota.type !== "single")).toBe(true);
  expectValid(shrunk);
});

it("删除知识点连带删除它的配额；改 id 同步改写引用", () => {
  const next = removeKnowledgePoint(addQuota(baseBlueprint), 0);
  expect(next.quotas).toEqual([]);
  const renamed = withKnowledgeId(addQuota(baseBlueprint), 0, "kp_new");
  expect(renamed.quotas?.[0]?.knowledgePoint).toBe("kp_new");
  expectValid(renamed);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm vitest run web/src/panels/blueprint-edit.test.ts`
Expected: FAIL on missing exports.

- [ ] **Step 3: Implement the functions**

- `quotaRemaining` = `typeMix[type]` minus the sum of other quotas of the same type; never negative.
- `addQuota` picks the first knowledge point and the first non-section type with remaining > 0; returns unchanged when none.
- `withQuotaCount` clamps to `1..quotaRemaining(blueprint, quota.type, index)`.
- `withQuotaType` ignores `section`, ignores a type with zero remaining, and clamps the count for the new type.
- `removeQuota` filters by index.
- `withKnowledgeId` rewrites quota references; `removeKnowledgePoint` drops them.
- Add `fitQuotas(quotas, typeMix)` and call it from `withSectionsAndMix`, so shrinking `typeMix` clamps or drops quotas in row order.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run web/src/panels/blueprint-edit.test.ts && pnpm --filter @intentform/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/panels/blueprint-edit.ts web/src/panels/blueprint-edit.test.ts
git commit -m "feat(web): 蓝图配额编辑纯函数 [P23]"
```

---

### Task 3: 蓝图卡配额编辑区

**Files:**
- Modify: `web/src/panels/BlueprintCard.tsx`
- Test: `web/src/panels/BlueprintCard.test.ts`

**Interfaces:**
- Consumes: Task 2 functions.
- Produces: test ids `plan-quota-add`, `plan-quota`, `plan-quota-kp`, `plan-quota-type`, `plan-quota-count`, `plan-quota-remove`.

- [ ] **Step 1: Extend the SSR test**

Add a blueprint with one knowledge point and one quota; assert output contains `立体几何`, `plan-quota`, and does not contain `>kp_solid<` (option value is allowed, visible id is not).

- [ ] **Step 2: Run test and confirm failure**

Run: `pnpm vitest run web/src/panels/BlueprintCard.test.ts`
Expected: FAIL because the quota section is absent.

- [ ] **Step 3: Implement the section**

Place it after the knowledge-point list and before the validation error, only for `kind === "quiz"`:

- Heading `按知识点指定题目`, button `加指定` (`data-testid="plan-quota-add"`), disabled when no knowledge points or no type capacity.
- When no knowledge points: hint `先在下面添加知识点，才能指定题目`.
- Each row: knowledge select (names only), type select (non-section; disable options whose remaining is 0 unless currently selected), count input (`w-16 text-right tabular-nums`, min 1, max remaining), delete button.
- Wire changes to Task 2 functions; `quota` fallback `[]`.
- Help text: `只钉住这里的组合；其余题仍按题型分布自由安排`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run web/src/panels/BlueprintCard.test.ts web/src/panels/blueprint-edit.test.ts && pnpm --filter @intentform/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/panels/BlueprintCard.tsx web/src/panels/BlueprintCard.test.ts
git commit -m "feat(web): 蓝图卡按知识点指定题型 [P23]"
```

---

### Task 4: 浏览器闭环与证据

**Files:**
- Modify: `scripts/browser-closed-loop.mjs`
- Modify: `docs/evidence/02b-plan.png`

**Interfaces:**
- Consumes: Task 3 test ids.

- [ ] **Step 1: Extend the plan step**

After the plan card appears and before the title edit:

1. Click `加知识点`; rename the last knowledge input to `立体几何`.
2. Click `plan-quota-add` twice.
3. Set row 0 type to `short`, row 1 type to `single` via native select value + `change` event; set counts to 1.
4. Assert two rows, both counts `1`, and knowledge select visible text `立体几何`.
5. Capture `02b-plan.png` with the quota rows visible.
6. Delete the added knowledge point (`删除知识点 N`) and assert `plan-quota` rows disappear; then continue the existing title edit and generation.

- [ ] **Step 2: Run the browser loop**

Run: `node scripts/browser-closed-loop.mjs`
Expected: 18 steps pass; `02b-plan.png` shows the quota section.

- [ ] **Step 3: Commit**

```bash
git add scripts/browser-closed-loop.mjs docs/evidence/02b-plan.png
git commit -m "test(scripts): 闭环覆盖蓝图知识点配额 [P23]"
```

---

### Task 5: 文档与最终验证

**Files:**
- Create: `docs/prompt-log/P23/summary.md`
- Modify: `README.md`
- Modify: `docs/prompt-log/README.md`

- [ ] **Step 1: Record the iteration**

Write the P23 summary: the user problem, the optional-quota decision, why prompt versions stay unchanged, the real failures found during implementation, and the final commands/evidence.

- [ ] **Step 2: Run the full gate**

Run: `pnpm check && node scripts/verify.mjs && node scripts/browser-closed-loop.mjs && node scripts/secret-scan.mjs && node scripts/secret-scan.mjs --history`
Expected: all pass; record exact file/test counts.

- [ ] **Step 3: Commit docs**

```bash
git add README.md docs/prompt-log/README.md docs/prompt-log/P23/summary.md
git commit -m "docs: 蓝图知识点题型配额留痕 [P23]"
```
