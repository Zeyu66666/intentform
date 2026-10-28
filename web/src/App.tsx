/**
 * 生成页外壳：三栏布局（需求 / 预览 / 时间线）。
 *
 * 三栏宽度由 `styles/tokens.css` 的 `--layout-left` / `--layout-right` 决定，
 * 中间栏用 `minmax(0, 1fr)` 而不是 `1fr`——`1fr` 的最小尺寸是 `auto`，
 * 一个长公式或长单词就能把中间栏撑破、逼出横向滚动条。
 *
 * 接线：
 *   RequirementPanel  ← 需求文本 / 生成 / 取消
 *   PreviewPanel      ← `selectPreviewFields()`（按 index 排序）+ 未解决校验失败
 *   TimelinePanel     ← `buildTimeline()`（阶段分组与耗时）
 * 状态全部来自 `useGenerateStream()` 的 `useReducer`，没有第二个状态源。
 */

import { useCallback, useMemo, useRef, useState } from "react";

import type { Clarification, ClarifyQuestion, ClarifySlotId, FormKind } from "@intentform/schema";

import { createClarifyApi } from "./api/clarify";
import { describeFailure } from "./api/failures";
import { createHttpClient } from "./api/http";
import { createTeacherApi } from "./api/teacher";
import { ClarifyForm } from "./panels/ClarifyForm";
import {
  EMPTY_DRAFTS,
  buildClarifications,
  setCustom,
  toggleOption,
  type ClarifyDrafts,
} from "./panels/clarify-model";
import { RequirementPanel } from "./panels/RequirementPanel";
import { PreviewPanel, type PreviewMode } from "./panels/PreviewPanel";
import { TimelinePanel } from "./panels/TimelinePanel";
import { PublishPanel } from "./publish/PublishPanel";
import type { PublishedForm } from "./publish/publish-flow";
import { readWebConfig } from "./config";
import { selectPreviewFields, selectUnresolvedErrors, type RunStatus } from "./stream/generate-machine";
import { createDemoStreamSource, DEMO_NOTICE } from "./stream/demo-source";
import { createFetchStreamSource, selectStreamMode, type StreamSource } from "./stream/source";
import { useGenerateStream } from "./stream/useGenerateStream";

const TERMINAL_TEXT: Record<RunStatus, string | null> = {
  idle: null,
  streaming: null,
  done: "生成完成",
  error: "生成失败：见右侧时间线",
  cancelled: "已取消：上游请求已中断，不当作错误",
};

/** 上游模式的中文说法。未知就写未知，不猜。 */
const UPSTREAM_MODE_LABELS: Readonly<Record<string, string>> = {
  live: "真实上游",
  record: "录制上游",
  replay: "回放录像（不调模型）",
  mock: "内置假数据",
};

function describeSource(streamMode: "live" | "fixture", upstreamMode: string | null): string {
  if (streamMode === "fixture") return "假帧（未联调）";
  if (upstreamMode === null) return "未知（等待响应头回执）";
  return UPSTREAM_MODE_LABELS[upstreamMode] ?? `未知模式 ${upstreamMode}`;
}

/**
 * 澄清的四个状态（R-05）。
 *
 * 「检查中」和「有问题要问」分开，是因为两者界面完全不同：
 * 前者不能点、后者要答题。合成一个 `loading: boolean` 会让按钮态与内容态互相打结。
 */
type ClarifyState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly questions: readonly ClarifyQuestion[] }
  | { readonly status: "error"; readonly message: string };

export function App(): JSX.Element {
  // 只读 `VITE_API_BASE`（`config.ts` 的白名单），且必须走 `resolveApiBase()`：
  // 前端零 Key，任何密钥类变量都不许出现在这里。
  const config = useMemo(() => readWebConfig({ VITE_API_BASE: import.meta.env.VITE_API_BASE }), []);
  const mode = useMemo(() => selectStreamMode(window.location.search, import.meta.env.DEV), []);

  // 上游模式来自服务端响应头（`x-intentform-llm-mode`）：回放与真实上游在事件流上
  // 完全一样，只有服务端知道自己在哪个模式，界面必须如实显示，不能让演示"看起来在调模型"。
  const [upstreamMode, setUpstreamMode] = useState<string | null>(null);

  const source = useMemo<StreamSource>(
    () =>
      mode === "fixture"
        ? createDemoStreamSource()
        : createFetchStreamSource({
            apiBase: config.apiBase,
            onUpstreamMode: (value) => {
              setUpstreamMode(value);
            },
          }),
    [mode, config.apiBase],
  );

  const { state, start, cancel, reset } = useGenerateStream(source);

  const [requirement, setRequirement] = useState("");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("edit");
  const [kind, setKind] = useState<FormKind>("quiz");

  // 发布结果留在 App：`PublishPanel` 只在 done 之后挂载，把结果存在它自己里面的化，
  // 下面任何一次重渲染（预览视角切换、时间线更新）都可能把刚拿到的短链弄丢。
  const [published, setPublished] = useState<PublishedForm | null>(null);

  // 唯一的 HTTP 出口（`credentials: "include"` + CSRF 头都在 `http.ts` 里）。
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);
  const clarifyApi = useMemo(() => createClarifyApi(createHttpClient()), []);

  // 澄清（R-05）：状态与草稿都留在 App，左栏只负责画。
  const [clarify, setClarify] = useState<ClarifyState>({ status: "idle" });
  const [drafts, setDrafts] = useState<ClarifyDrafts>(EMPTY_DRAFTS);
  /** 澄清请求的序号：需求被改动后，迟到的追问不再覆盖界面。 */
  const clarifyTokenRef = useRef(0);

  const beginGeneration = useCallback(
    (requirementText: string, clarifications: readonly Clarification[]): void => {
      setPublished(null);
      setClarify({ status: "idle" });
      setDrafts(EMPTY_DRAFTS);
      start(requirementText, clarifications);
    },
    [start],
  );

  /**
   * 点「生成表单」：先问一次「缺不缺槽位」，再决定是直接生成还是弹追问。
   * 澄清接口不可用时给出两条出路（重试 / 仍然生成），**不静默跳过**——
   * 悄悄跳过会让「意图控制」在演示里变成一段没有发生的对话。
   */
  const requestStart = useCallback((): void => {
    const requirementText = requirement.trim();
    if (requirementText === "") return;
    if (mode === "fixture") {
      beginGeneration(requirementText, []);
      return;
    }
    const token = clarifyTokenRef.current + 1;
    clarifyTokenRef.current = token;
    setClarify({ status: "loading" });
    void clarifyApi.clarify({ requirement: requirementText, kind }).then((outcome) => {
      if (clarifyTokenRef.current !== token) return;
      if (!outcome.ok) {
        setClarify({
          status: "error",
          message: describeFailure(outcome.failure, {
            notFound: "澄清接口不存在（服务端版本旧或没启动）",
          }),
        });
        return;
      }
      if (outcome.data.questions.length === 0) {
        beginGeneration(requirementText, []);
        return;
      }
      setDrafts(EMPTY_DRAFTS);
      setClarify({ status: "ready", questions: outcome.data.questions });
    });
  }, [requirement, mode, clarifyApi, kind, beginGeneration]);

  const fields = selectPreviewFields(state);
  const fieldNodes = useMemo(() => fields.map((entry) => entry.node), [fields]);
  const errors = selectUnresolvedErrors(state);
  /** 追问块：只在后端真的回了追问时出现；「跳过」永远在旁边。 */
  const clarifySlot =
    clarify.status === "ready" ? (
      <ClarifyForm
        questions={clarify.questions}
        drafts={drafts}
        onToggleOption={(slot: ClarifySlotId, option: string) => {
          setDrafts((previous) => toggleOption(previous, slot, option));
        }}
        onCustomChange={(slot: ClarifySlotId, text: string) => {
          setDrafts((previous) => setCustom(previous, slot, text));
        }}
        onConfirm={() => {
          beginGeneration(
            requirement.trim(),
            buildClarifications(clarify.questions, drafts),
          );
        }}
        onSkip={() => {
          beginGeneration(requirement.trim(), []);
        }}
      />
    ) : clarify.status === "loading" ? (
      <p className="m-0 text-sm text-muted" data-testid="clarify-loading" aria-live="polite">
        正在检查需求是否写全…
      </p>
    ) : clarify.status === "error" ? (
      <section className="flex flex-col gap-1 rounded-sm border border-danger bg-surface p-2" role="alert">
        <p className="m-0 text-sm text-danger">{clarify.message}</p>
        <button
          type="button"
          onClick={requestStart}
          className="w-full rounded-sm border border-line px-2 py-1 text-xs text-muted"
        >
          重试
        </button>
        <button
          type="button"
          data-testid="clarify-still-generate"
          onClick={() => {
            beginGeneration(requirement.trim(), []);
          }}
          className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white"
        >
          仍然生成
        </button>
      </section>
    ) : null;

  const terminalText = TERMINAL_TEXT[state.status];
  const terminalTone =
    state.status === "error" ? "text-danger" : state.status === "done" ? "text-success" : "text-muted";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-line bg-surface px-2 py-1">
        <h1 className="m-0 text-lg font-semibold">意卷 IntentForm</h1>
        <span className="text-xs text-muted">自然语言 → 结构化表单</span>
        {/* 右侧信息合成一组：单独用 ml-auto 的兄弟元素在窄屏会被挤出可视区。 */}
        <div className="ml-auto flex min-w-0 flex-wrap items-baseline justify-end gap-2">
          {terminalText === null ? null : (
            <span className={`text-xs ${terminalTone}`} aria-live="polite">
              {terminalText}
            </span>
          )}
          <span className="text-xs text-muted" data-testid="data-source">
            数据源：{describeSource(mode, upstreamMode)} · {config.apiBase}/generate
          </span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-[var(--layout-gap)] overflow-y-auto p-2 xl:grid-cols-[var(--layout-left)_minmax(0,1fr)_var(--layout-right)] xl:overflow-hidden">
        <section
          aria-label="需求输入"
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface"
        >
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <RequirementPanel
              requirement={requirement}
              status={state.status}
              kind={kind}
              onKindChange={setKind}
              onRequirementChange={(value) => {
                setRequirement(value);
                // 需求改了，上一轮的追问就不再对应当前文本：收起，下次重新检查。
                if (clarify.status !== "idle") setClarify({ status: "idle" });
              }}
              onStart={requestStart}
              onCancel={cancel}
              onReset={() => {
                reset();
                setRequirement("");
                setPublished(null);
                setClarify({ status: "idle" });
                setDrafts(EMPTY_DRAFTS);
              }}
              demoNotice={mode === "fixture" ? DEMO_NOTICE : null}
              clarifySlot={clarifySlot}
            />
          </div>
          {state.status === "done" ? (
            <PublishPanel
              fields={fieldNodes}
              requirementText={requirement}
              kind={kind}
              api={api}
              published={published}
              onPublished={setPublished}
            />
          ) : null}
        </section>

        <section
          aria-label="实时预览"
          className="min-h-0 min-w-0 overflow-hidden rounded-md border border-line bg-surface"
        >
          <PreviewPanel
            fields={fields}
            errors={errors}
            mode={previewMode}
            status={state.status}
            onModeChange={setPreviewMode}
          />
        </section>

        <section
          aria-label="思考时间线"
          className="min-h-0 min-w-0 overflow-hidden rounded-md border border-line bg-surface"
        >
          <TimelinePanel state={state} />
        </section>
      </main>
    </div>
  );
}
