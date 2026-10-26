/**
 * 左栏：需求输入 + 3 个预置需求 + 生成 / 取消。
 *
 * 预置需求的文本**必须**来自 `@intentform/schema` 的 `GENERATE_PRESETS`：
 * 回放文件的 hash 把需求原文算进去了，前端抄一份副本，改一个错别字就换一个 hash，
 * 回放当场未命中（见 `packages/schema/src/presets.ts` 顶部注释）。
 */

import { GENERATE_PRESETS, LIMITS } from "@intentform/schema";

import type { RunStatus } from "../stream/generate-machine";

export interface RequirementPanelProps {
  readonly requirement: string;
  readonly status: RunStatus;
  readonly onRequirementChange: (value: string) => void;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  /** 假数据模式的提示语；生产（live）为 null。 */
  readonly demoNotice: string | null;
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
  onRequirementChange,
  onStart,
  onCancel,
  onReset,
  demoNotice,
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

      <div className="mt-auto flex flex-col gap-1">
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart}
          className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {streaming ? "生成中…" : "生成表单"}
        </button>
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
