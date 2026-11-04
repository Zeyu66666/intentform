# 生成深度：难度契约、参考卷与联网开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将生成从“题型/知识点合法”升级为“基础→提升→综合→压轴递进”，支持教师参考卷优先和 live-only 联网补充。

**Architecture:** plan 阶段接收参考卷文本和可选搜索结果，只提取为难度蓝图与风格备注；generate 阶段只接收教师确认后的结构化蓝图，永远拿不到原始参考/搜索文本。搜索配置沿用现有进程内存 LLM 设置，离线模式四道闸强制不外呼。

**Tech Stack:** TypeScript strict、Zod、React 18、原生 `fetch`、现有 NDJSON/SSE/replay 机制、Vitest、CDP Chrome 闭环。

**Spec:** `docs/superpowers/specs/2026-11-04-generation-depth-design.md`

## Global Constraints

- 教师参考卷只提取结构、难度、知识点和风格；不复制题干、选项、数字、答案、解析，不做改数字伪原创。
- 生成阶段不得接收参考卷或搜索原文；只接收确认后的 `FormBlueprint`。
- 搜索只有 `live ∧ webSearch=true ∧ searchBaseUrl 非空 ∧ searchKey 非空` 才允许外呼；`mock/replay/record` 零外呼。
- 搜索 Key 只存进程内存、不写磁盘/数据库/日志，响应只回 `hasSearchKey`。
- 旧蓝图和无参考旧 replay key 保持兼容；提示词升级为 `plan.v2` / `generate.v4` 后必须重录 6 条 fixture。
- 不新增依赖；每个 feat/fix/test commit 带 `[P24]`；每个 commit 单独过 `pnpm typecheck`。

## Review Focus

- 参考卷含“请照抄原题”等指令：只进 plan 提炼，生成提示不得出现该原文或其特征串。
- `webSearch=true` 但运行于 mock/replay/record：搜索 fetch 必须零调用并回执 off。
- 搜索端点超时、返回坏 JSON、缺 URL：降级为不搜索，不阻断蓝图规划，不记录 Key。
- 旧蓝图没有 `difficultyMix/styleNotes`：仍能 parse、编辑、生成。
- 编辑难度分布后章节/题型/难度三者总数始终一致。

---

### Task 1: schema 难度契约与请求字段

**Files:**
- Modify: `packages/schema/src/constants.ts`
- Modify: `packages/schema/src/blueprint.ts`
- Modify: `packages/schema/src/api.ts`
- Test: `packages/schema/src/blueprint.test.ts`
- Test: `packages/schema/src/api.test.ts`

**Interfaces:**
- Produces: `DIFFICULTY_LEVELS`, `DifficultyLevel`, `DIFFICULTY_LABELS`
- Produces: `FormBlueprint.difficultyMix?: Readonly<Partial<Record<DifficultyLevel, number>>> | undefined`
- Produces: `FormBlueprint.styleNotes?: string | undefined`
- Produces: `PlanRequest.reference?: string | undefined`, `PlanRequest.webSearch?: boolean | undefined`

- [ ] **Step 1: Write failing tests**
  - Valid blueprint accepts difficulty mix summing to total and style notes.
  - Wrong difficulty sum and unknown key reject.
  - Old blueprint without both fields remains valid.
  - Plan request accepts reference ≤ 20000 chars and webSearch; oversized reference rejects.
- [ ] **Step 2: Run RED**
  - `pnpm vitest run packages/schema/src/blueprint.test.ts packages/schema/src/api.test.ts`
  - Expected: new fields missing/rejected.
- [ ] **Step 3: Implement**
  - Add the four difficulty levels and strict six-key mix with default 0.
  - Add optional `styleNotes` max 500, optional `difficultyMix`; superRefine sum when present.
  - Extend plan request with optional bounded reference and webSearch.
- [ ] **Step 4: Verify**
  - `pnpm vitest run packages/schema/src/blueprint.test.ts packages/schema/src/api.test.ts && pnpm --filter @intentform/schema typecheck`
- [ ] **Step 5: Commit**
  - `git commit -m "feat(schema): 生成难度与参考卷契约 [P24]"`

### Task 2: 蓝图编辑难度配平

**Files:** `web/src/panels/blueprint-edit.ts`, `web/src/panels/blueprint-edit.test.ts`

**Interfaces:**
- Produces `withDifficultyCount(blueprint, level, value): FormBlueprint`
- Existing section/type mutations preserve `difficultyMix` when present.

- [ ] **Step 1: RED tests** — initial difficulty distribution; changing difficulty changes total and rebalances sections/types; changing section/type rebalances difficulty; old blueprints stay unchanged.
- [ ] **Step 2: Run `pnpm vitest run web/src/panels/blueprint-edit.test.ts` and observe failure.**
- [ ] **Step 3: Implement** — reuse existing largest-remainder distribution; keep absent `difficultyMix` absent.
- [ ] **Step 4: Verify** — affected test + web typecheck.
- [ ] **Step 5: Commit** — `feat(web): 蓝图难度分布编辑 [P24]`.

### Task 3: plan/generate prompt v2/v4 and reference isolation

**Files:** `packages/llm/src/plan.ts`, `packages/llm/src/prompt.ts`, `packages/llm/src/config.ts`, tests in `packages/llm/src/plan.test.ts` and `prompt.test.ts`

**Interfaces:**
- `PLAN_PROMPT_VERSION = "plan.v2"`; `DEFAULT_PROMPT_VERSION = "generate.v4"`.
- `buildPlanMessages(requirement, reference?, searchResults?)` accepts optional bounded reference/search data.
- `buildUserPrompt(requirement, blueprint?)` never accepts raw reference/search.

- [ ] **Step 1: RED tests** — plan prompt contains difficulty rules and reference isolation; generate prompt contains serialized confirmed difficulty/styleNotes but not a reference marker/feature string; mock blueprint has difficulty sum.
- [ ] **Step 2: Run affected LLM tests and observe failure.**
- [ ] **Step 3: Implement prompt versions, structured difficulty instructions, anti-copy rules, `styleNotes`; update mock blueprint deterministically.**
- [ ] **Step 4: Verify affected LLM tests and typecheck.**
- [ ] **Step 5: Commit** — `feat(llm): 生成难度递进与参考卷隔离 [P24]`.

### Task 4: replay key reference hash

**Files:** `packages/llm/src/replay-key.ts`, `packages/llm/src/replay-key.test.ts`, `fixtures/replays/README.md`

**Interfaces:**
- `ReplayKeyInput.reference?: string | undefined`
- `replayKeyMaterial` includes empty ref segment for absent reference; uses first 16 chars of SHA-256 normalized reference when present.

- [ ] **Step 1: RED tests** — absent reference preserves old key material; adding/changing reference changes key; whitespace-equivalent references hash identically.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify tests/typecheck and update fixture contract docs.**
- [ ] **Step 4: Commit** — `feat(llm): 回放键加入参考卷指纹 [P24]`.

### Task 5: search runtime and settings

**Files:** `packages/schema/src/api.ts`, `server/src/llm-runtime.ts`, `server/src/llm-settings-route.ts`, `server/src/plan-route.ts`, new `server/src/search.ts`; tests for runtime/settings/plan/search.

**Interfaces:**
- `LlmRuntimeConfig.searchBaseUrl?: string`, `searchApiKey?: string` internal only.
- `SearchResult { title; snippet; url }`.
- `searchWeb(config, query, fetchImpl?): Promise<readonly SearchResult[]>`.
- settings response adds `searchBaseUrl`, `hasSearchKey`; request adds optional search fields.

- [ ] **Step 1: RED tests** — valid result parsing; malformed/timeout → []; all non-live or missing config → zero fetch; settings never echoes key.
- [ ] **Step 2: Implement native fetch with 8s timeout, strict result filtering, warn-only failure; four gates in plan route.**
- [ ] **Step 3: Verify server tests/typecheck.**
- [ ] **Step 4: Commit** — `feat(server): live 联网参考搜索与内存设置 [P24]`.

### Task 6: plan route and generation UI

**Files:** `server/src/plan-route.ts`, `web/src/api/teacher.ts`, `web/src/panels/RequirementPanel.tsx`, `web/src/App.tsx`, related tests.

**Interfaces:**
- Plan response/request transports `reference`, `webSearch`, `searchStatus`, `searchCount` without exposing keys.

- [ ] **Step 1: RED tests** — reference reaches plan only; search status off in mock/replay; UI reference textarea and disabled offline checkbox render.
- [ ] **Step 2: Implement request transport and timeline receipt.**
- [ ] **Step 3: Verify web/server tests and typecheck.**
- [ ] **Step 4: Commit** — `feat(web): 参考试卷与联网参考开关 [P24]`.

### Task 7: BlueprintCard UI

**Files:** `web/src/panels/BlueprintCard.tsx`, `BlueprintCard.test.ts`

- [ ] **Step 1: RED test** — difficulty labels/inputs render and no old blueprint breaks.
- [ ] **Step 2: Implement four Chinese difficulty inputs with existing readable numeric style.**
- [ ] **Step 3: Verify tests/typecheck.**
- [ ] **Step 4: Commit** — `feat(web): 蓝图难度分布界面 [P24]`.

### Task 8: fixture recording and full validation

**Files:** `fixtures/replays/*`, `packages/llm/src/fixtures.test.ts`, `packages/llm/src/check-fixtures.ts`, docs.

- [ ] **Step 1: Before recording, run `LLM_MODE=record` with system `LLM_API_KEY`; record 3 plan + 3 generate fixtures with `plan.v2/generate.v4`, truthful metadata.**
- [ ] **Step 2: Run `node scripts/check-fixtures.mjs` and affected fixture tests.**
- [ ] **Step 3: Run `pnpm check`, `node scripts/verify.mjs`, browser closed loop, both secret scans.**
- [ ] **Step 4: Update P24 summary and README counts.**
- [ ] **Step 5: Commit fixtures/docs with `[P24]`.**

## Rulings

- Teacher reference has priority over requirement text and search material; confirmed by user.
- Reference is paste-text first; Word/PDF parsing is out of scope.
- Search is a generic POST adapter accepted by user; supplier-specific proxy is external configuration.
- No original reference question text enters generation; no copy/rewrite-by-number allowed.
- Live Key exists in system environment, so prompt upgrade and fixture re-recording are in scope.
- Search is never attempted in mock/replay/record, even if request checkbox is true.
- `scale` is excluded from knowledge-point quotas, but this P24 difficulty feature may still count scale in type mix.
- The new prompt versions require six fresh truthful fixtures; old fixtures are not relabeled.
