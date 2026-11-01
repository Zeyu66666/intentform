/**
 * 打印版考卷 `/forms/<id>/print`（省赛附加 A-17）。
 *
 * 三条边界：
 * 1. **教师专属**：数据来自 `GET /api/forms/:id`（带答案的教师视图），未登录时
 *    与编辑页同一套失败提示，不做匿名打印。
 * 2. **打印的是草稿版**：就是编辑器里正在改的那一版；要打印已发布版，先发布
 *    （发布会把草稿指针跟到那一版），页面顶部如实写出「当前草稿 vN」。
 * 3. **「含答案」是本地开关**：勾上才渲染答案与解析，且屏幕上的开关在打印时
 *    由 `.no-print` 隐藏——纸上不会出现「拖动开关」这种界面文字。
 *
 * 打印样式在 `styles/index.css` 的 `@media print`：藏外壳、去阴影、一题不跨页。
 */

import { useEffect, useMemo, useState } from "react";

import type { FormSchema } from "@intentform/schema";

import { createHttpClient, type ApiFailure } from "../api/http";
import { createTeacherApi } from "../api/teacher";
import { describeFailure, isUnauthorized } from "../api/failures";
import { Link } from "../Link";
import { MathText } from "../render/Latex";
import { TYPE_LABELS } from "../render/FieldRegistry";
import { buildPrintSheet, printHeaderText } from "./sheet";
import { routeToPath } from "../router";

const PAGE = "mx-auto w-full max-w-[800px] px-3 py-4";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly failure: ApiFailure }
  | {
      readonly status: "ready";
      /** 原始 schema 留着：开关切换时用它重建卷面，不再发一次请求。 */
      readonly schema: FormSchema;
      readonly versionN: number;
    };

export function PrintPage({ formId }: { readonly formId: string }): JSX.Element {
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);
  const [withAnswers, setWithAnswers] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    void api.getForm(formId).then((outcome) => {
      if (cancelled) return;
      if (!outcome.ok) {
        setLoad({ status: "error", failure: outcome.failure });
        return;
      }
      setLoad({ status: "ready", schema: outcome.data.schema, versionN: outcome.data.version.n });
    });
    return () => {
      cancelled = true;
    };
  }, [api, formId]);

  if (load.status === "loading") {
    return (
      <main className={PAGE}>
        <p className="m-0 text-sm text-muted">正在加载表单…</p>
      </main>
    );
  }

  if (load.status === "error") {
    const needsLogin = isUnauthorized(load.failure);
    return (
      <main className={PAGE}>
        <section className="rounded-md border border-danger bg-surface p-3" role="alert">
          <p className="m-0 text-base text-danger">
            {describeFailure(load.failure, { notFound: "这份表单不存在，或已被删除" })}
          </p>
          <p className="m-0 mt-1 text-sm text-muted">
            {needsLogin ? (
              <Link href="/login" className="text-accent underline">
                去登录
              </Link>
            ) : (
              <Link href={routeToPath({ name: "dashboard", formId })} className="text-accent underline">
                回看板
              </Link>
            )}
          </p>
        </section>
      </main>
    );
  }

  const schema = load.schema;
  const rows = buildPrintSheet(schema, { withAnswers });
  const isSurvey = schema.meta.kind === "survey";

  return (
    <main className={`${PAGE} text-ink`}>
      <div className="no-print mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-2">
        <span className="text-sm text-muted">{`当前草稿 v${String(load.versionN)}`}</span>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            data-testid="print-with-answers"
            className="size-4 accent-accent"
            checked={withAnswers}
            disabled={isSurvey}
            onChange={(event) => {
              setWithAnswers(event.target.checked);
            }}
          />
          含答案与解析
        </label>
        <button
          type="button"
          data-testid="print-run"
          className="min-h-[44px] rounded-sm border border-accent px-3 text-sm text-accent"
          onClick={() => {
            window.print();
          }}
        >
          打印
        </button>
        {isSurvey ? <span className="text-xs text-muted">问卷没有标准答案</span> : null}
        <Link
          href={routeToPath({ name: "edit", formId })}
          className="ml-auto text-sm text-muted underline"
        >
          回编辑页
        </Link>
      </div>

      <article data-testid="print-sheet" className="print-sheet rounded-md border border-line bg-surface p-4 print:border-0 print:p-0">
        <header className="mb-3 border-b border-line pb-2 text-center">
          <h1 className="m-0 text-xl font-semibold">{schema.meta.title}</h1>
          <p className="m-0 mt-1 text-sm text-muted">{printHeaderText(schema)}</p>
          <p className="m-0 mt-2 text-sm text-muted">姓名 __________　　班级 __________　　学号 __________</p>
        </header>

        {rows.map((row) =>
          row.kind === "section" ? (
            <section key={row.id} className="print-section mt-3">
              <h2 className="m-0 border-b border-line pb-1 text-lg font-semibold">{row.title}</h2>
              {row.description === undefined ? null : (
                <p className="m-0 mt-1 text-sm text-muted">{row.description}</p>
              )}
            </section>
          ) : (
            <section key={row.id} className="print-question mt-3" data-testid={`print-q-${row.id}`}>
              <p className="m-0 text-base font-medium">
                <span className="mr-1 tabular-nums">{`${String(row.no)}.`}</span>
                <MathText text={row.title} />
                {row.score === undefined ? null : (
                  <span className="ml-1 text-sm text-muted">{`（${String(row.score)} 分）`}</span>
                )}
                <span className="ml-1 text-xs text-muted">{`[${TYPE_LABELS[row.type]}]`}</span>
              </p>

              {row.options.length === 0 ? null : (
                <ol className="m-0 mt-1 grid list-none grid-cols-1 gap-1 p-0 sm:grid-cols-2 print:grid-cols-2">
                  {row.options.map((option) => (
                    <li key={option.letter} className="text-base">
                      <span className="mr-1 tabular-nums text-muted">{`${option.letter}.`}</span>
                      <MathText text={option.text} />
                    </li>
                  ))}
                </ol>
              )}

              {row.blanks === 0 ? null : (
                <div className="mt-1 flex flex-col gap-2">
                  {Array.from({ length: row.blanks }, (_, index) => (
                    <span
                      key={String(index)}
                      aria-hidden="true"
                      className="block h-6 border-b border-line"
                    />
                  ))}
                </div>
              )}

              {row.answer === undefined && row.explanation === undefined ? null : (
                <div className="mt-1 rounded-sm border border-line bg-bg p-1 text-sm print:border-0 print:bg-transparent print:p-0">
                  {row.answer === undefined ? null : (
                    <p className="m-0">
                      <span className="text-muted">答案：</span>
                      <MathText text={row.answer} />
                    </p>
                  )}
                  {row.explanation === undefined ? null : (
                    <p className="m-0 mt-1">
                      <span className="text-muted">解析：</span>
                      <MathText text={row.explanation} />
                    </p>
                  )}
                </div>
              )}
            </section>
          ),
        )}
      </article>
    </main>
  );
}
