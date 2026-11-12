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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Clarification,
  ClarifyQuestion,
  ClarifySlotId,
  CreateFormResponse,
  FormBlueprint,
  FormItem,
  FormKind,
  Objective,
  PlanSearchStatus,
} from "@intentform/schema";
import { summarizeBlueprint } from "@intentform/schema";

import { createClarifyApi } from "./api/clarify";
import { createPlanApi } from "./api/plan";
import { createReferenceApi } from "./api/reference";
import { describeFailure } from "./api/failures";
import { createHttpClient } from "./api/http";
import { readRuntimeMode } from "./api/runtime";
import { createTeacherApi } from "./api/teacher";
import { BlueprintCard } from "./panels/BlueprintCard";
import { ClarifyForm } from "./panels/ClarifyForm";
import {
  EMPTY_DRAFTS,
  buildClarifications,
  setCustom,
  toggleOption,
  type ClarifyDrafts,
} from "./panels/clarify-model";
import { RequirementPanel, type ReferenceUploadState } from "./panels/RequirementPanel";
import { PreviewPanel, type PreviewMode } from "./panels/PreviewPanel";
import { TimelinePanel } from "./panels/TimelinePanel";
import { SaveDraftPanel } from "./publish/SaveDraftPanel";
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

/**
 * 蓝图（R-06）的状态。`ready` 里带着**当次所用的补答**——确认生成时要把它们
 * 原样再发一遍，否则"规划看到的需求"与"生成看到的需求"会不是同一段。
 */
type PlanState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly blueprint: FormBlueprint;
      readonly summary: string;
      readonly clarifications: readonly Clarification[];
      /** 服务端回执：联网参考是否真的发生（离线模式恒为 off）。 */
      readonly searchStatus: PlanSearchStatus;
      readonly searchCount: number;
      /** 这次规划是否带了参考卷（回执用；之后改左栏文本不影响它）。 */
      readonly usedReference: boolean;
    }
  | { readonly status: "error"; readonly message: string };

/** 联网参考回执的人话。`off` 是默认状态，也要显示，避免「以为搜了」。 */
function searchReceiptText(status: PlanSearchStatus, count: number): string {
  switch (status) {
    case "used":
      return `联网参考：已搜到 ${String(count)} 条（只取结构/风格，不复用原题）`;
    case "empty":
      return "联网参考：已调用搜索，但没有可用结果";
    case "failed":
      return "联网参考：搜索失败，已按不联网继续规划";
    case "off":
      return "联网参考：未启用（离线模式或未配置搜索）";
  }
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

  const lastGenerationRef = useRef<{
    readonly requirement: string;
    readonly clarifications: readonly Clarification[];
    readonly blueprint?: FormBlueprint;
  } | null>(null);

  const [requirement, setRequirement] = useState("");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("edit");
  const [kind, setKind] = useState<FormKind>("quiz");
  /** 从上传文件提取出的参考试卷：只随 `/api/plan` 发送，生成请求里没有这个字段。 */
  const [reference, setReference] = useState("");
  const [referenceUpload, setReferenceUpload] = useState<ReferenceUploadState>({ status: "idle" });
  /** 上传解析的序号：连着换文件时，迟到的结果不能覆盖后选的那一份。 */
  const referenceTokenRef = useRef(0);
  /** 请求级联网开关；服务端四道闸会再判一次。 */
  const [webSearch, setWebSearch] = useState(false);
  /**
   * 服务端当前 LLM 模式（`/healthz`）。`null` = 没读到（服务未起/网络问题）。
   * 只有确定为 `live` 才允许勾选联网，其余情况一律禁用并说明原因。
   */
  const [runtimeMode, setRuntimeMode] = useState<string | null>(null);
  /**
   * 「先看蓝图再生成」开关（A-02）：默认开，走两阶段；关掉时跳过规划直接生成。
   * 关掉之后两阶段对照不会出现——界面上如实写明，而不是让时间线"少一段"。
   */
  const [planFirst, setPlanFirst] = useState(true);

  // 保存结果留在 App：`SaveDraftPanel` 只在 done 之后挂载，把结果存在它自己里面的化，
  // 下面任何一次重渲染（预览视角切换、时间线更新）都可能把刚拿到的编辑入口弄丢。
  const [saved, setSaved] = useState<CreateFormResponse | null>(null);
  /** 保存前就地改过的题：按字段 id 覆盖生成结果，保存时一起带走。 */
  const [fieldEdits, setFieldEdits] = useState<Readonly<Record<string, FormItem>>>({});
  /** 生成蓝图里的知识点，供预览里的「教学标注」下拉使用。 */
  const [objectives, setObjectives] = useState<readonly Objective[]>([]);

  // 唯一的 HTTP 出口（`credentials: "include"` + CSRF 头都在 `http.ts` 里）。
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);
  const clarifyApi = useMemo(() => createClarifyApi(createHttpClient()), []);
  const planApi = useMemo(() => createPlanApi(createHttpClient()), []);
  const referenceApi = useMemo(() => createReferenceApi(createHttpClient()), []);

  const handleReferenceFile = useCallback(
    (file: File | null): void => {
      const token = referenceTokenRef.current + 1;
      referenceTokenRef.current = token;
      if (file === null) {
        setReference("");
        setReferenceUpload({ status: "idle" });
        return;
      }
      setReference("");
      setReferenceUpload({ status: "loading", filename: file.name });
      void referenceApi.extract(file).then((outcome) => {
        if (referenceTokenRef.current !== token) return;
        if (!outcome.ok) {
          setReferenceUpload({
            status: "error",
            filename: file.name,
            message: describeFailure(outcome.failure, {
              notFound: "参考试卷解析接口不存在（服务端版本旧或没启动）",
            }),
          });
          return;
        }
        setReference(outcome.data.text);
        setReferenceUpload({
          status: "ready",
          filename: outcome.data.filename,
          charCount: outcome.data.charCount,
          truncated: outcome.data.truncated,
          warnings: outcome.data.warnings,
        });
      });
    },
    [referenceApi],
  );

  useEffect(() => {
    let cancelled = false;
    void readRuntimeMode().then((mode) => {
      if (!cancelled) setRuntimeMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const planTokenRef = useRef(0);
  /** 最近一次规划用的补答：规划失败重试时不能把教师刚答的东西弄丢。 */
  const lastClarificationsRef = useRef<readonly Clarification[]>([]);

  // 澄清（R-05）：状态与草稿都留在 App，左栏只负责画。
  const [clarify, setClarify] = useState<ClarifyState>({ status: "idle" });
  const [drafts, setDrafts] = useState<ClarifyDrafts>(EMPTY_DRAFTS);
  /** 澄清请求的序号：需求被改动后，迟到的追问不再覆盖界面。 */
  const clarifyTokenRef = useRef(0);

  const beginGeneration = useCallback(
    (
      requirementText: string,
      clarifications: readonly Clarification[],
      blueprint?: FormBlueprint,
    ): void => {
      setSaved(null);
      setFieldEdits({});
      setObjectives(blueprint?.knowledgePoints ?? []);
      setClarify({ status: "idle" });
      setPlan({ status: "idle" });
      setDrafts(EMPTY_DRAFTS);
      lastGenerationRef.current = {
        requirement: requirementText,
        clarifications,
        ...(blueprint === undefined ? {} : { blueprint }),
      };
      start(requirementText, clarifications, blueprint, kind);
    },
    [start, kind],
  );

  /**
   * 澄清走完之后的第二站：请模型规划结构。
   *
   * 规划接口不可用时不静默跳过（那会让"两阶段"在演示里凭空消失），
   * 而是给两条出路：重试，或明确降级为"跳过蓝图"。
   */
  const requestPlan = useCallback(
    (requirementText: string, clarifications: readonly Clarification[]): void => {
      const token = planTokenRef.current + 1;
      planTokenRef.current = token;
      lastClarificationsRef.current = clarifications;
      setClarify({ status: "idle" });
      setPlan({ status: "loading" });
      const trimmedReference = reference.trim();
      void planApi
        .plan({
          requirement: requirementText,
          kind,
          clarifications: [...clarifications],
          ...(trimmedReference === "" ? {} : { reference: trimmedReference }),
          ...(webSearch ? { webSearch: true } : {}),
        })
        .then((outcome) => {
          if (planTokenRef.current !== token) return;
          if (!outcome.ok) {
            setPlan({
              status: "error",
              message: describeFailure(outcome.failure, {
                notFound: "蓝图接口不存在（服务端版本旧或没启动）",
              }),
            });
            return;
          }
          setPlan({
            status: "ready",
            blueprint: outcome.data.blueprint,
            summary: outcome.data.summary,
            clarifications,
            searchStatus: outcome.data.searchStatus,
            searchCount: outcome.data.searchCount,
            usedReference: trimmedReference !== "",
          });
        });
    },
    [planApi, kind, reference, webSearch],
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
        // 需求已经够完整：看「先看蓝图」开关决定是规划还是直接生成。
        if (planFirst) requestPlan(requirementText, []);
        else beginGeneration(requirementText, []);
        return;
      }
      setDrafts(EMPTY_DRAFTS);
      setClarify({ status: "ready", questions: outcome.data.questions });
    });
  }, [requirement, mode, clarifyApi, kind, requestPlan, beginGeneration, planFirst]);

  const fields = selectPreviewFields(state);
  const editedFields = useMemo(
    () =>
      fields.map((entry) => ({
        ...entry,
        node: fieldEdits[entry.node.id] ?? entry.node,
      })),
    [fields, fieldEdits],
  );
  const fieldNodes = useMemo(() => editedFields.map((entry) => entry.node), [editedFields]);
  const errors = selectUnresolvedErrors(state);
  const retryGeneration = useCallback((): void => {
    const last = lastGenerationRef.current;
    if (last === null) return;
    beginGeneration(last.requirement, last.clarifications, last.blueprint);
  }, [beginGeneration]);
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
          const answers = buildClarifications(clarify.questions, drafts);
          if (planFirst) requestPlan(requirement.trim(), answers);
          else beginGeneration(requirement.trim(), answers);
        }}
        onSkip={() => {
          if (planFirst) requestPlan(requirement.trim(), []);
          else beginGeneration(requirement.trim(), []);
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

  // 生成前的两步共用左栏同一块位置：先追问（若缺槽位），再蓝图确认。
  const preStepSlot =
    plan.status === "ready" ? (
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 rounded-sm border border-line bg-bg p-2 text-xs text-muted">
          <span data-testid="plan-search-receipt">
            {searchReceiptText(plan.searchStatus, plan.searchCount)}
          </span>
          {plan.usedReference ? (
            <span data-testid="plan-reference-receipt">
              参考卷：已用于提炼结构（不复用原题）
            </span>
          ) : null}
        </div>
        <BlueprintCard
          blueprint={plan.blueprint}
          onChange={(blueprint) => {
            setPlan((current) =>
              current.status === "ready"
                ? { ...current, blueprint, summary: summarizeBlueprint(blueprint) }
                : current,
            );
          }}
          onConfirm={() => {
            beginGeneration(requirement.trim(), plan.clarifications, plan.blueprint);
          }}
          onSkip={() => {
            beginGeneration(requirement.trim(), plan.clarifications);
          }}
        />
      </div>
    ) : plan.status === "loading" ? (
      <p className="m-0 text-sm text-muted" data-testid="plan-loading" aria-live="polite">
        正在规划结构…
      </p>
    ) : plan.status === "error" ? (
      <section className="flex flex-col gap-1 rounded-sm border border-danger bg-surface p-2" role="alert">
        <p className="m-0 text-sm text-danger">{plan.message}</p>
        <button
          type="button"
          onClick={() => {
            requestPlan(requirement.trim(), lastClarificationsRef.current);
          }}
          className="w-full rounded-sm border border-line px-2 py-1 text-xs text-muted"
        >
          重试
        </button>
        <button
          type="button"
          data-testid="plan-still-generate"
          onClick={() => {
            beginGeneration(requirement.trim(), lastClarificationsRef.current);
          }}
          className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white"
        >
          跳过蓝图，直接生成
        </button>
      </section>
    ) : (
      clarifySlot
    );

  const webSearchDisabled = runtimeMode !== "live";
  const webSearchHint =
    runtimeMode === "live"
      ? "仅在当前 live 模式生效；服务端还要配置搜索端点与 Key。"
      : runtimeMode === null
        ? "未读到服务端运行模式：联网参考只在 live 模式可用，暂不可勾选。"
        : "当前为离线演示模式，联网参考不会生效。";

  const terminalText = TERMINAL_TEXT[state.status];
  const terminalTone =
    state.status === "error" ? "text-danger" : state.status === "done" ? "text-success" : "text-muted";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-line bg-surface px-2 py-1">
        {/* 品牌与主导航在登录后的顶栏里，这里只留本页的运行状态，避免两行重复的站名。 */}
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
          className="flex max-h-full min-h-0 min-w-0 flex-col self-start overflow-y-auto rounded-md border border-line bg-surface"
        >
          <div className="min-w-0">
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
                setReference("");
                setReferenceUpload({ status: "idle" });
                setWebSearch(false);
                setSaved(null);
                setClarify({ status: "idle" });
                setPlan({ status: "idle" });
                setDrafts(EMPTY_DRAFTS);
              }}
              demoNotice={mode === "fixture" ? DEMO_NOTICE : null}
              preStepSlot={preStepSlot}
              planFirst={planFirst}
              onPlanFirstChange={setPlanFirst}
              reference={reference}
              referenceUpload={referenceUpload}
              onReferenceFileChange={handleReferenceFile}
              webSearch={webSearch}
              onWebSearchChange={setWebSearch}
              webSearchDisabled={webSearchDisabled}
              webSearchHint={webSearchHint}
            />
          </div>
          {state.status === "done" ? (
            <SaveDraftPanel
              fields={fieldNodes}
              requirementText={requirement}
              kind={kind}
              api={api}
              saved={saved}
              onSaved={setSaved}
            />
          ) : null}
        </section>

        <section
          aria-label="实时预览"
          className="min-h-0 min-w-0 overflow-hidden rounded-md border border-line bg-surface"
        >
          <PreviewPanel
            fields={editedFields}
            errors={errors}
            objectives={objectives}
            onFieldChange={(item) => {
              setFieldEdits((current) => ({ ...current, [item.id]: item }));
            }}
            mode={previewMode}
            status={state.status}
            onModeChange={setPreviewMode}
          />
        </section>

        <section
          aria-label="思考时间线"
          className="min-h-0 min-w-0 overflow-hidden rounded-md border border-line bg-surface"
        >
          <TimelinePanel state={state} onRetry={retryGeneration} />
        </section>
      </main>
    </div>
  );
}
