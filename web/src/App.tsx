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

import { useMemo, useState } from "react";

import type { FormKind } from "@intentform/schema";

import { createHttpClient } from "./api/http";
import { createTeacherApi } from "./api/teacher";
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

  const fields = selectPreviewFields(state);
  const fieldNodes = useMemo(() => fields.map((entry) => entry.node), [fields]);
  const errors = selectUnresolvedErrors(state);
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
              onRequirementChange={setRequirement}
              onStart={() => {
                setPublished(null);
                start(requirement);
              }}
              onCancel={cancel}
              onReset={() => {
                reset();
                setRequirement("");
                setPublished(null);
              }}
              demoNotice={mode === "fixture" ? DEMO_NOTICE : null}
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
