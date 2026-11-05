/**
 * 左栏：需求输入 + 3 个预置需求 + 生成 / 取消。
 *
 * 预置需求的文本**必须**来自 `@intentform/schema` 的 `GENERATE_PRESETS`：
 * 回放文件的 hash 把需求原文算进去了，前端抄一份副本，改一个错别字就换一个 hash，
 * 回放当场未命中（见 `packages/schema/src/presets.ts` 顶部注释）。
 */

import {
  FORM_KINDS,
  GENERATE_PRESETS,
  LIMITS,
  PLAN_REFERENCE_MAX_CHARS,
  REFERENCE_UPLOAD_MAX_BYTES,
  type FormKind,
} from "@intentform/schema";

import { FORM_KIND_LABELS } from "../dashboard/model";
import type { RunStatus } from "../stream/generate-machine";

/** 参考卷上传的界面状态；文本本身仍在 `reference`，这里只描述文件与解析进度。 */
export type ReferenceUploadState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly filename: string }
  | {
      readonly status: "ready";
      readonly filename: string;
      readonly charCount: number;
      readonly truncated: boolean;
      readonly warnings: readonly string[];
    }
  | { readonly status: "error"; readonly filename: string; readonly message: string };

export interface RequirementPanelProps {
  readonly requirement: string;
  readonly status: RunStatus;
  /** 要生成的表类型：测验判分、问卷不判分（`survey` 会把分值/答案从草稿里剥掉）。 */
  readonly kind: FormKind;
  readonly onKindChange: (kind: FormKind) => void;
  readonly onRequirementChange: (value: string) => void;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  /** 假数据模式的提示语；生产（live）为 null。 */
  readonly demoNotice: string | null;
  /**
   * 生成前的步骤块（省赛 R-05 追问 / R-06 蓝图）。非空时它**顶替**「生成表单」
   * 按钮的位置：此刻下一步动作在块里，再摆一个同名主按钮只会让人多点一次。
   */
  readonly preStepSlot?: JSX.Element | null;
  /**
   * 「先看蓝图再生成」开关（A-02 文档里的入口）。默认开：走两阶段。
   * 关掉时跳过规划，直接逐字段生成——两阶段对照因此不会出现，界面如实说明。
   */
  readonly planFirst: boolean;
  readonly onPlanFirstChange: (value: boolean) => void;
  /** 从上传文件提取出的参考试卷文本（只进规划阶段，不复制原题）。 */
  readonly reference: string;
  readonly referenceUpload: ReferenceUploadState;
  /** 选文件 / 清空；`null` 表示移除当前参考卷。 */
  readonly onReferenceFileChange: (file: File | null) => void;
  /** 请求级联网参考开关；服务端还会按模式与配置再判一次。 */
  readonly webSearch: boolean;
  readonly onWebSearchChange: (value: boolean) => void;
  /** 非 live 模式禁用开关（离线模式永不外呼）。 */
  readonly webSearchDisabled: boolean;
  /** 禁用/可用原因，直接显示在开关下方。 */
  readonly webSearchHint: string;
}

const STATUS_TEXT: Record<RunStatus, string> = {
  idle: "待生成",
  streaming: "生成中",
  done: "已完成",
  error: "出错",
  cancelled: "已取消",
};

const STATUS_TONE: Record<RunStatus, string> = {
  idle: "text-muted",
  streaming: "text-accent",
  done: "text-success",
  error: "text-danger",
  cancelled: "text-muted",
};

export function RequirementPanel({
  requirement,
  status,
  kind,
  onKindChange,
  onRequirementChange,
  onStart,
  onCancel,
  onReset,
  demoNotice,
  preStepSlot = null,
  planFirst,
  onPlanFirstChange,
  reference,
  referenceUpload,
  onReferenceFileChange,
  webSearch,
  onWebSearchChange,
  webSearchDisabled,
  webSearchHint,
}: RequirementPanelProps): JSX.Element {
  const length = requirement.length;
  const overLimit = length > LIMITS.requirementMaxChars;
  const streaming = status === "streaming";
  const canStart = requirement.trim() !== "" && !overLimit && !streaming;
  const canReset = status !== "idle" && !streaming;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <header className="flex items-baseline justify-between">
        <h2 className="m-0 text-lg font-semibold">需求</h2>
        <span className={`text-xs ${STATUS_TONE[status]}`} aria-live="polite">
          {STATUS_TEXT[status]}
        </span>
      </header>

      <label htmlFor="requirement-input" className="text-xs text-muted">
        用一句话描述你要的测验或问卷，题目数量、题型分布、知识点都可以写进去。
      </label>

      <textarea
        id="requirement-input"
        value={requirement}
        onChange={(event) => {
          onRequirementChange(event.target.value);
        }}
        rows={5}
        disabled={streaming}
        aria-describedby="requirement-counter"
        placeholder="例：出一份初二数学《二次函数》的入门测验，8 道题……"
        className="w-full resize-y rounded-sm border border-line bg-surface p-2 text-sm disabled:opacity-60"
      />

      <div id="requirement-counter" className="flex justify-between text-xs text-muted">
        <span>最长 {LIMITS.requirementMaxChars} 字</span>
        <span className={overLimit ? "text-danger" : undefined}>
          {length} / {LIMITS.requirementMaxChars}
        </span>
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="m-0 text-xs font-semibold text-muted">预置需求</h3>
        {GENERATE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={streaming}
            onClick={() => {
              onRequirementChange(preset.requirement);
            }}
            title={preset.requirement}
            className="w-full rounded-sm border border-line bg-surface px-2 py-1 text-left text-sm hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {preset.label}
          </button>
        ))}
      </section>

      <section className="flex flex-col gap-1">
        <details className="rounded-sm border border-line bg-surface">
          <summary className="cursor-pointer px-2 py-1 text-xs font-semibold text-muted">
            参考试卷（可选）
          </summary>
          <div className="flex flex-col gap-2 p-2 pt-0">
            <p className="m-0 text-xs text-muted">
              上传 .docx 或 .pdf。只提取题型比例、难度梯度与命题风格，<strong>不会复制原题</strong>。
            </p>
            <label
              className={`inline-flex min-h-[36px] w-fit cursor-pointer items-center rounded-sm border border-line bg-surface px-2 text-sm text-ink ${
                streaming || referenceUpload.status === "loading" ? "cursor-not-allowed opacity-60" : "hover:border-accent hover:text-accent"
              }`}
            >
              选择文件
              <input
                type="file"
                data-testid="reference-file"
                accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={streaming || referenceUpload.status === "loading"}
                aria-label="上传参考试卷"
                onChange={(event) => {
                  onReferenceFileChange(event.currentTarget.files?.[0] ?? null);
                  // 允许连续选择同一个文件：不清空 value 时第二次不会触发 change。
                  event.currentTarget.value = "";
                }}
                className="sr-only"
              />
            </label>

            {referenceUpload.status === "loading" ? (
              <p className="m-0 text-xs text-muted" data-testid="reference-loading">
                正在解析 {referenceUpload.filename}…
              </p>
            ) : null}

            {referenceUpload.status === "error" ? (
              <p className="m-0 text-xs text-danger" data-testid="reference-error" role="alert">
                {referenceUpload.message}
              </p>
            ) : null}

            {referenceUpload.status === "ready" ? (
              <div className="flex flex-col gap-1" data-testid="reference-ready">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-ink">
                    {referenceUpload.filename} · {referenceUpload.charCount} 字
                  </span>
                  <button
                    type="button"
                    data-testid="reference-clear"
                    disabled={streaming}
                    onClick={() => {
                      onReferenceFileChange(null);
                    }}
                    className="shrink-0 text-muted underline underline-offset-2 disabled:opacity-50"
                  >
                    移除
                  </button>
                </div>
                {referenceUpload.warnings.map((warning) => (
                  <p key={warning} className="m-0 text-xs text-danger">
                    {warning}
                  </p>
                ))}
                <details>
                  <summary className="cursor-pointer text-xs text-muted">查看提取的文字</summary>
                  <pre
                    data-testid="reference-text"
                    className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg p-2 text-xs text-ink"
                  >
                    {reference.slice(0, 4000)}
                  </pre>
                </details>
              </div>
            ) : null}

            {referenceUpload.status === "idle" ? (
              <p className="m-0 text-xs text-muted">
                最多 {Math.floor(REFERENCE_UPLOAD_MAX_BYTES / (1024 * 1024))} MiB，提取后最多{" "}
                {PLAN_REFERENCE_MAX_CHARS} 字
              </p>
            ) : null}
          </div>
        </details>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="m-0 text-xs font-semibold text-muted">表单类型</h3>
        <div role="group" aria-label="表单类型" className="flex gap-1">
          {FORM_KINDS.map((value) => {
            const selected = value === kind;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                disabled={streaming}
                onClick={() => {
                  onKindChange(value);
                }}
                className={`flex-1 rounded-sm border px-2 py-1 text-xs disabled:opacity-50 ${
                  selected
                    ? "border-accent bg-accent text-white"
                    : "border-line bg-surface text-muted hover:border-accent hover:text-accent"
                }`}
              >
                {FORM_KIND_LABELS[value]}
              </button>
            );
          })}
        </div>
        {kind === "survey" ? (
          <p className="m-0 text-xs text-muted">问卷不判分，题目不带答案</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="m-0 text-xs font-semibold text-muted">生成方式</h3>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            data-testid="plan-first"
            className="size-4 accent-accent"
            checked={planFirst}
            disabled={streaming}
            onChange={(event) => {
              onPlanFirstChange(event.target.checked);
            }}
          />
          先看蓝图再生成
        </label>
        <p className="m-0 text-xs text-muted">
          {planFirst ? "先规划结构，确认后逐字段生成" : "跳过蓝图，直接逐字段生成（不会出现蓝图对照）"}
        </p>
      </section>

      <section className="flex flex-col gap-1">
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            data-testid="web-search"
            className="size-4 accent-accent"
            checked={webSearch}
            disabled={streaming || webSearchDisabled}
            onChange={(event) => {
              onWebSearchChange(event.target.checked);
            }}
          />
          联网参考
        </label>
        <p className="m-0 text-xs text-muted" data-testid="web-search-hint">
          {webSearchHint}
        </p>
      </section>

      <div className="flex flex-col gap-1">
        {preStepSlot ?? (
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart}
            data-testid="generate-start"
            className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {streaming ? "生成中…" : "生成表单"}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={!streaming}
          className="w-full rounded-sm border border-danger px-2 py-1 text-sm text-danger disabled:cursor-not-allowed disabled:opacity-30"
        >
          取消生成
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={!canReset}
          className="w-full rounded-sm border border-line px-2 py-1 text-xs text-muted disabled:cursor-not-allowed disabled:opacity-30"
        >
          清空重来
        </button>
      </div>

      {demoNotice === null ? null : (
        <p className="m-0 rounded-sm border border-line bg-bg p-1 text-xs text-muted">{demoNotice}</p>
      )}
    </div>
  );
}
