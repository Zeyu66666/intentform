/**
 * 学生填写页 `/f/:slug`。
 *
 * 这一层只做三件事：取数、把事件转成 action、按状态选一块界面。判断全在
 * `fill/*.ts` 里（`mapFillLoad` / `beginSubmit` / `mapSubmitOutcome` / `canSubmit`），
 * 因为 vitest 只收 `.ts`，逻辑留在 `.tsx` 就等于没有测试。
 *
 * 三条红线在这里体现为"不渲染"：
 *   1. 成功态只用 `submit.success.summary`（得分/满分或"已提交"）；
 *      **不回显任何作答内容，也不显示每题对错**——`SubmitResponse` 里本来就没有。
 *   2. 409 只显示契约文案 + "刷新页面"按钮；不自动刷新（会把写了一半的答案冲掉）。
 *   3. 渲染只用 `view.form`（`PublicForm`），类型上就没有答案/解析/层级/知识点。
 */

import { useEffect, useMemo, useReducer, useState } from "react";
import type { FormEvent } from "react";

import { VERSION_CONFLICT_MESSAGE } from "@intentform/schema";

import { createFillApi } from "../api/fill";
import { createHttpClient } from "../api/http";
import { Link } from "../Link";
import { answerReducer, EMPTY_ANSWERS } from "./answers";
import { mapFillLoad, type FillLoad } from "./errors";
import { StudentField } from "./StudentField";
import {
  beginSubmit,
  buildSubmitRequest,
  canSubmit,
  mapSubmitOutcome,
  missingSummary,
  type SubmitState,
} from "./submit";

const MAX_WIDTH = "mx-auto w-full max-w-2xl px-2 py-3";

export function StudentPage({ slug }: { readonly slug: string }): JSX.Element {
  // 一个客户端一个实例：`createHttpClient()` 里只有 fetch，没有可变状态，
  // 但保持引用稳定能让下面两个 effect 的依赖数组老实（不然每次渲染都会重新取数）。
  const api = useMemo(() => createFillApi(createHttpClient()), []);

  const [load, setLoad] = useState<FillLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [answers, dispatch] = useReducer(answerReducer, EMPTY_ANSWERS);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    setLoad(null);
    void api.load(slug).then((outcome) => {
      // 组件已卸载或 slug 变了：这次响应作废，不 setState（否则会把新 slug 的界面写脏）。
      if (cancelled) return;
      setLoad(mapFillLoad(outcome));
    });
    return () => {
      cancelled = true;
    };
  }, [api, slug, attempt]);

  const view = load !== null && load.kind === "ready" ? load.view : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (view === null) return;

    const next = beginSubmit(view.form.items, answers);
    setSubmit(next);
    if (next.kind !== "submitting") return;

    void api.submit(buildSubmitRequest(view, answers)).then((outcome) => {
      setSubmit(mapSubmitOutcome(outcome, view.form.meta.kind));
    });
  };

  if (load === null) {
    return (
      <main className={MAX_WIDTH}>
        <p className="text-sm text-muted">正在加载表单…</p>
      </main>
    );
  }

  if (load.kind === "error") {
    return (
      <main className={MAX_WIDTH}>
        <section className="rounded-md border border-line bg-surface p-3">
          <p className="m-0 text-base text-danger" role="alert">
            {load.message}
          </p>
          {load.retryable ? (
            <button
              type="button"
              className="mt-2 min-h-[44px] rounded-sm border border-accent px-2 py-1 text-sm text-accent"
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              重试
            </button>
          ) : (
            <p className="m-0 mt-1 text-sm text-muted">请向老师确认链接是否正确。</p>
          )}
        </section>
      </main>
    );
  }

  if (submit.kind === "success") {
    return (
      <main className={MAX_WIDTH}>
        <section className="rounded-md border border-success bg-surface p-3 text-center">
          <p className="m-0 text-sm text-muted">{view === null ? "" : view.form.meta.title}</p>
          {/* 只有这一句：得分 / 满分（quiz）或「已提交」（survey）。 */}
          <p className="m-0 mt-1 text-xl font-semibold text-success">{submit.success.summary}</p>
          <p className="m-0 mt-1 text-sm text-muted">答案已记录，可以关闭这个页面</p>
        </section>
      </main>
    );
  }

  if (view === null) {
    // 理论不可达：`load.kind === "ready"` 时 view 必非 null。留着是为了让类型收敛。
    return (
      <main className={MAX_WIDTH}>
        <p className="text-sm text-muted">表单数据异常，请刷新页面。</p>
      </main>
    );
  }

  const missing = submit.kind === "blocked" ? submit.missing : [];
  const missingIds = new Set(missing.map((field) => field.fieldId));
  const meta = view.form.meta;

  return (
    <main className={MAX_WIDTH}>
      <header className="mb-2">
        <h1 className="m-0 text-lg font-semibold text-ink">{meta.title}</h1>
        <p className="m-0 mt-1 text-xs text-muted">
          {meta.kind === "quiz"
            ? meta.totalScore === undefined
              ? "判分测验"
              : `判分测验 · 满分 ${String(meta.totalScore)} 分`
            : "问卷 · 不计分"}
        </p>
      </header>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          onSubmit(event);
        }}
        noValidate
      >
        {view.form.items.map((item) => (
          <StudentField
            key={item.id}
            item={item}
            answers={answers}
            invalid={missingIds.has(item.id)}
            dispatch={dispatch}
          />
        ))}

        {submit.kind === "blocked" ? (
          <section
            className="rounded-md border border-danger bg-surface p-2"
            role="alert"
            data-testid="fill-missing"
          >
            <p className="m-0 text-sm font-medium text-danger">{missingSummary(missing)}</p>
            <ul className="m-0 mt-1 list-disc pl-3 text-sm text-danger">
              {missing.map((field) => (
                <li key={field.fieldId} data-testid={`fill-missing-${field.fieldId}`}>
                  {`第 ${String(field.position)} 题：${field.title}`}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {submit.kind === "conflict" ? (
          <section
            className="rounded-md border border-danger bg-surface p-2"
            role="alert"
            data-testid="fill-conflict"
          >
            <p className="m-0 text-sm text-danger">{VERSION_CONFLICT_MESSAGE}</p>
            <button
              type="button"
              className="mt-2 min-h-[44px] rounded-sm border border-accent px-2 py-1 text-sm text-accent"
              onClick={() => {
                // 不自动刷新：让教师/学生自己决定什么时候丢弃当前输入。
                window.location.reload();
              }}
            >
              刷新页面
            </button>
          </section>
        ) : null}

        {submit.kind === "failed" ? (
          <p className="m-0 text-sm text-danger" role="alert" data-testid="fill-failed">
            {submit.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit(submit)}
          data-testid="fill-submit"
          className="min-h-[44px] w-full rounded-sm bg-accent px-2 py-1 text-base font-medium text-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel(submit)}
        </button>

        <p className="m-0 text-center text-xs text-muted">
          <Link href="/" className="text-muted underline">
            意卷 IntentForm
          </Link>
        </p>
      </form>
    </main>
  );
}

/** 按钮文案。穷举 `SubmitState`，新增状态时编译不过。 */
function submitLabel(state: SubmitState): string {
  switch (state.kind) {
    case "idle":
    case "blocked":
    case "failed":
      return "提交";
    case "submitting":
      return "提交中…";
    case "success":
      return "已提交";
    case "conflict":
      return "请刷新页面后再提交";
    default:
      return assertNeverState(state);
  }
}

function assertNeverState(state: never): never {
  throw new Error(`未处理的提交状态: ${JSON.stringify(state)}`);
}
