/**
 * 右栏：思考时间线。
 *
 * 分组与耗时全部来自 `stream/timeline.ts` 的纯函数（可单测），这里只负责画：
 * - 阶段耗时 = 相邻 `phase.ts` 之差；最后一段用 `done.stats.ms` 反推；
 * - `thinking` 按 `kind` 分流：`summary` 一行，`reasoning` 只报段数（不展开原文，§2.4）；
 * - `field` 显示"第几个节点 / 类型 / 出现时刻"；
 * - `field_error` 标红并显示 `ERROR_HINTS` 文案（不显示裸错误码）；
 * - `repair` 显示「第 N 轮：E_X → 已修复/仍失败」；
 * - `seq` 乱序/跳号的异常在这里以"协议异常"形式列出——容错不等于假装没发生。
 */

import { buildTimeline, formatMs, type TimelineStage } from "../stream/timeline";
import type { GenerateState, RunStatus } from "../stream/generate-machine";

export interface TimelinePanelProps {
  readonly state: GenerateState;
}

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: "空闲",
  streaming: "进行中",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};

const STATUS_CLASS: Record<RunStatus, string> = {
  idle: "text-muted",
  streaming: "text-accent",
  done: "text-success",
  error: "text-danger",
  cancelled: "text-muted",
};

export function TimelinePanel({ state }: TimelinePanelProps): JSX.Element {
  const timeline = buildTimeline(state);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-line px-2 py-1">
        <h2 className="m-0 text-lg font-semibold">思考时间线</h2>
        <span className={`text-xs ${STATUS_CLASS[state.status]}`}>{STATUS_LABEL[state.status]}</span>
        <span className="ml-auto text-xs text-muted">
          {timeline.totalElapsedMs === null ? "—" : formatMs(timeline.totalElapsedMs)} · {timeline.appliedCount} 事件
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-live="polite">
        {timeline.stages.length === 0 ? (
          <p className="m-0 text-sm text-muted">还没有事件。</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {timeline.stages.map((stage) => (
              <li key={stage.key}>
                <StageBlock stage={stage} streaming={state.status === "streaming"} isLast={stage.key === timeline.stages[timeline.stages.length - 1]?.key} />
              </li>
            ))}
          </ol>
        )}

        {timeline.anomalies.length === 0 ? null : (
          <details className="mt-2 rounded-sm border border-line px-2 py-1">
            <summary className="cursor-pointer text-xs text-muted">
              协议异常 {timeline.anomalies.length} 条（seq 乱序 / 坏帧 / 缺号跳过，已容错但未隐藏）
            </summary>
            <ul className="m-0 mt-1 flex list-none flex-col gap-[2px] p-0">
              {timeline.anomalies.map((anomaly, index) => (
                <li key={`${anomaly.kind}-${String(index)}`} className="text-xs text-muted">
                  <span className="text-danger">{anomaly.label}</span>
                  {anomaly.seq === null ? "" : ` #${String(anomaly.seq)}`}：{anomaly.note}
                </li>
              ))}
            </ul>
          </details>
        )}

        {timeline.stats === null ? null : (
          <p className="mt-2 mb-0 text-xs text-muted">
            共 {timeline.stats.fields} 个节点 · 校验失败 {timeline.stats.errors} 次 · 修复{" "}
            {timeline.stats.repairs} 轮 · 端到端 {formatMs(timeline.stats.ms)}
          </p>
        )}
      </div>
    </div>
  );
}

function StageBlock({
  stage,
  streaming,
  isLast,
}: {
  readonly stage: TimelineStage;
  readonly streaming: boolean;
  readonly isLast: boolean;
}): JSX.Element {
  const active = streaming && isLast;
  const empty =
    stage.summaries.length === 0 &&
    stage.reasoning === "" &&
    stage.fields.length === 0 &&
    stage.errors.length === 0 &&
    stage.repairs.length === 0 &&
    stage.usages.length === 0;

  return (
    <div className={`rounded-sm border px-2 py-1 ${active ? "border-accent" : "border-line"}`}>
      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-semibold ${active ? "text-accent" : "text-ink"}`}>
          {stage.label}
          {stage.occurrence > 1 ? `（第 ${String(stage.occurrence)} 次）` : ""}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted">
          {stage.durationMs === null ? (active ? "进行中" : "—") : formatMs(stage.durationMs)}
        </span>
      </div>

      {stage.startsAtMs === null ? null : (
        <p className="m-0 text-xs text-muted">入场 +{formatMs(stage.startsAtMs)}</p>
      )}

      {stage.summaries.map((summary, index) =>
        summary === "" ? null : (
          <p key={`s${String(index)}`} className="m-0 mt-1 text-sm">
            {summary}
          </p>
        ),
      )}

      {/* 推理原文不再展开（《计划 v3.0》§2.4）：模型自述最容易被读成"它真的这样想"，
          而实际推理过程不可核验。只保留段数这一可观测事实。 */}
      {stage.reasoningChunks === 0 ? null : (
        <p className="mt-1 mb-0 text-xs text-muted">推理摘要 {stage.reasoningChunks} 段</p>
      )}

      {stage.fields.length === 0 ? null : (
        <ul className="m-0 mt-1 flex list-none flex-col gap-[2px] p-0">
          {stage.fields.map((field) => (
            <li key={`f${String(field.seq)}`} className="flex items-baseline gap-1 text-xs">
              <span className="shrink-0 text-success">＋</span>
              <span className="shrink-0 text-muted">
                #{field.index + 1} {field.typeLabel}
              </span>
              <span className="min-w-0 truncate text-ink">{field.title}</span>
              <span className="ml-auto shrink-0 text-muted">{formatMs(field.tMs)}</span>
            </li>
          ))}
        </ul>
      )}

      {stage.errors.length === 0 ? null : (
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
          {stage.errors.map((error) => (
            <li key={`e${String(error.seq)}`} className="rounded-sm bg-bg px-1 py-[2px]">
              <p className="m-0 text-xs text-danger">
                ✕ {error.id}（第 {error.index + 1} 项）{error.resolved ? "已修复" : "仍失败"}
              </p>
              {error.hints.map((hint, index) => (
                <p key={`h${String(index)}`} className="m-0 text-xs text-muted">
                  {hint}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}

      {stage.repairs.length === 0 ? null : (
        <ul className="m-0 mt-1 flex list-none flex-col gap-[2px] p-0">
          {stage.repairs.map((repair) => (
            <li
              key={`r${String(repair.seq)}`}
              className={`text-xs ${repair.status === "fixed" ? "text-success" : "text-danger"}`}
            >
              {repair.text}
            </li>
          ))}
        </ul>
      )}

      {stage.usages.map((usage) => (
        <p key={`u${String(usage.seq)}`} className="m-0 mt-1 text-xs text-muted">
          token：输入 {usage.promptTokens} / 输出 {usage.completionTokens} · {formatMs(usage.ms)}
        </p>
      ))}

      {empty && active ? <p className="m-0 mt-1 text-xs text-muted">…</p> : null}
    </div>
  );
}
