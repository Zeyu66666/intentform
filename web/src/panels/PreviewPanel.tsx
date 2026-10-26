/**
 * 中栏：实时预览（分节 + 题目卡片流），带 `edit` / `fill` 两态切换。
 *
 * `edit` 用 `EditField`（答案、解析、分值、bloom、知识点都在）；
 * `fill` 用 `FillField`（只有作答控件）。切换只是换注册表，不是换一个布尔开关，
 * 所以"学生视角"不可能因为某个 props 传错而漏出答案。
 */

import { ERROR_HINTS, type FormItem } from "@intentform/schema";

import { EditField, FillField } from "../render/FieldRegistry";
import type { FieldErrorEntry, FieldEntry, RunStatus } from "../stream/generate-machine";

export type PreviewMode = "edit" | "fill";

export interface PreviewPanelProps {
  readonly fields: readonly FieldEntry[];
  readonly errors: ReadonlyMap<number, FieldErrorEntry>;
  readonly mode: PreviewMode;
  readonly status: RunStatus;
  readonly onModeChange: (mode: PreviewMode) => void;
}

const MODE_LABEL: Record<PreviewMode, string> = {
  edit: "教师视角",
  fill: "学生视角",
};

const STATUS_TIP: Record<RunStatus, string> = {
  idle: "点左侧「生成表单」开始。",
  streaming: "正在逐字段生成，出现即渲染。",
  done: "生成完成，可以切到学生视角检查有没有漏答案。",
  error: "生成中断，右侧时间线里有失败原因。",
  cancelled: "已取消，已生成的部分保留在预览里。",
};

export function PreviewPanel({
  fields,
  errors,
  mode,
  status,
  onModeChange,
}: PreviewPanelProps): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1">
        <h2 className="m-0 text-lg font-semibold">预览</h2>
        <span className="text-xs text-muted">{fields.length} 个节点</span>

        <div
          role="group"
          aria-label="预览视角"
          className="ml-auto flex overflow-hidden rounded-sm border border-line"
        >
          {(["edit", "fill"] as const).map((value) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onModeChange(value);
                }}
                className={`px-2 py-1 text-xs ${
                  active ? "bg-accent text-white" : "bg-surface text-muted hover:text-accent"
                }`}
              >
                {MODE_LABEL[value]}
              </button>
            );
          })}
        </div>
      </header>

      <p className="m-0 border-b border-line bg-bg px-2 py-1 text-xs text-muted">
        {mode === "fill"
          ? "学生视角：答案、解析、分值、bloom、知识点全部不渲染（接口层还有 publicView 兜底）。"
          : STATUS_TIP[status]}
      </p>

      {/* aria-live：逐字段追加时屏幕阅读器能跟上，而不是等整张表单生成完。 */}
      <div
        aria-live="polite"
        aria-busy={status === "streaming"}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        {fields.length === 0 ? (
          <p className="text-sm text-muted">还没有字段。{STATUS_TIP[status]}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {fields.map((entry) => {
              const error = errors.get(entry.index);
              return (
                <div key={entry.node.id} className={error === undefined ? undefined : "rounded-md border border-danger p-1"}>
                  {error === undefined ? null : (
                    <div className="mb-1">
                      <p className="m-0 text-xs text-danger">
                        第 {entry.index + 1} 项校验未通过：{error.codes.join("、")}
                      </p>
                      {/* 错误码不是给人看的：跟时间线一样带出固定修复文案。 */}
                      <p className="m-0 text-xs text-muted">
                        {error.codes.map((code) => ERROR_HINTS[code]).join(" ")}
                      </p>
                    </div>
                  )}
                  <ItemView item={entry.node} mode={mode} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemView({ item, mode }: { readonly item: FormItem; readonly mode: PreviewMode }): JSX.Element {
  // 两态各自走自己的注册表：这里没有 `if (mode === "fill") hideAnswer()` 之类的分支。
  return mode === "edit" ? <EditField item={item} /> : <FillField item={item} />;
}
