/**
 * 模型设置 `/settings`（2026-11-03）。
 *
 * 四个模式与端点、模型名都在这里改；API Key 只提交给服务端、只存进程内存、
 * 永不回显。留空表示保持原 Key，避免改端点时被迫重输。
 *
 * 这条页面不写 `.env`：重启服务后回到环境变量里的启动配置。界面把这句话写出来，
 * 免得有人以为网页改完就永久生效。
 */

import { useEffect, useMemo, useState } from "react";

import {
  LLM_MODES,
  LLM_MODE_LABELS,
  type LlmModeName,
  type LlmSettingsResponse,
} from "@intentform/schema";

import { describeFailure } from "../api/failures";
import { createHttpClient } from "../api/http";
import { createTeacherApi } from "../api/teacher";

const PAGE = "mx-auto w-full max-w-3xl px-2 py-3" as const;
const INPUT =
  "mt-1 min-h-[44px] w-full rounded-sm border border-line bg-surface px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly settings: LlmSettingsResponse };

export function SettingsPage(): JSX.Element {
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [mode, setMode] = useState<LlmModeName>("mock");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [searchBaseUrl, setSearchBaseUrl] = useState("");
  const [searchApiKey, setSearchApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly tone: "success" | "error"; readonly text: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void api.getLlmSettings().then((outcome) => {
      if (cancelled) return;
      if (!outcome.ok) {
        setLoad({ status: "error", message: describeFailure(outcome.failure, { notFound: "设置接口不存在" }) });
        return;
      }
      setLoad({ status: "ready", settings: outcome.data });
      setMode(outcome.data.mode);
      setBaseUrl(outcome.data.baseUrl);
      setModel(outcome.data.model);
      setSearchBaseUrl(outcome.data.searchBaseUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (load.status === "loading") {
    return <main className={PAGE}><p className="text-sm text-muted">正在读取模型设置…</p></main>;
  }
  if (load.status === "error") {
    return (
      <main className={PAGE}>
        <p className="text-sm text-danger" role="alert">{load.message}</p>
      </main>
    );
  }

  const canEdit = load.settings.canEdit;

  const save = (): void => {
    if (busy || !canEdit) return;
    setBusy(true);
    setNotice(null);
    void api
      .updateLlmSettings({
        mode,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        searchBaseUrl: searchBaseUrl.trim(),
        ...(searchApiKey.trim() === "" ? {} : { searchApiKey: searchApiKey.trim() }),
      })
      .then((outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setNotice({ tone: "error", text: describeFailure(outcome.failure, { notFound: "设置接口不存在" }) });
          return;
        }
        setLoad({ status: "ready", settings: outcome.data });
        setMode(outcome.data.mode);
        setBaseUrl(outcome.data.baseUrl);
        setModel(outcome.data.model);
        setSearchBaseUrl(outcome.data.searchBaseUrl);
        setApiKey("");
        setSearchApiKey("");
        setNotice({ tone: "success", text: "已应用；下一条模型请求立即使用新配置。" });
      });
  };

  return (
    <main className={PAGE}>
      <h1 className="m-0 text-lg font-semibold text-ink">模型设置</h1>
      <p className="m-0 mt-1 text-sm text-muted">
        只影响当前服务进程，不写 <code>.env</code>；重启后回到启动配置。
      </p>

      <section className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface p-3" data-testid="llm-settings">
        <label className="flex flex-col gap-1 text-sm text-ink">
          运行模式
          <select
            data-testid="llm-mode"
            className={INPUT}
            value={mode}
            disabled={!canEdit || busy}
            onChange={(event) => {
              setMode(event.target.value as LlmModeName);
              setNotice(null);
            }}
          >
            {LLM_MODES.map((value) => (
              <option key={value} value={value}>{LLM_MODE_LABELS[value]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm text-ink">
          API 端点
          <input
            data-testid="llm-base-url"
            className={INPUT}
            value={baseUrl}
            disabled={!canEdit || busy}
            placeholder="https://api.deepseek.com/v1"
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setNotice(null);
            }}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-ink">
          模型名
          <input
            data-testid="llm-model"
            className={INPUT}
            value={model}
            disabled={!canEdit || busy}
            placeholder="deepseek-chat"
            onChange={(event) => {
              setModel(event.target.value);
              setNotice(null);
            }}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-ink">
          API Key
          <input
            data-testid="llm-api-key"
            className={INPUT}
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={!canEdit || busy}
            placeholder={load.settings.hasApiKey ? "已配置；留空保持不变" : "未配置；live/record 需要"}
            onChange={(event) => {
              setApiKey(event.target.value);
              setNotice(null);
            }}
          />
          <span className="text-xs text-muted">
            {load.settings.hasApiKey ? "服务端已保存 Key（不会回显）。" : "服务端当前没有 Key。"}
          </span>
        </label>

        <div className="mt-1 border-t border-line pt-3">
          <h2 className="m-0 text-sm font-semibold text-ink">联网参考搜索（可选）</h2>
          <p className="m-0 mt-1 text-xs text-muted">
            只在 live 模式、且教师勾选「联网参考」时才会调用。端点需接受
            <code> POST {'{query, limit}'} </code>并返回
            <code> {'{results:[{title,snippet,url}]}'} </code>；供应商差异请用一行代理适配。
          </p>
        </div>

        <label className="flex flex-col gap-1 text-sm text-ink">
          搜索端点
          <input
            data-testid="search-base-url"
            className={INPUT}
            value={searchBaseUrl}
            disabled={!canEdit || busy}
            placeholder="留空 = 不启用联网参考"
            onChange={(event) => {
              setSearchBaseUrl(event.target.value);
              setNotice(null);
            }}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-ink">
          搜索 Key
          <input
            data-testid="search-api-key"
            className={INPUT}
            type="password"
            autoComplete="off"
            value={searchApiKey}
            disabled={!canEdit || busy}
            placeholder={load.settings.hasSearchKey ? "已配置；留空保持不变" : "未配置；调用搜索端点需要"}
            onChange={(event) => {
              setSearchApiKey(event.target.value);
              setNotice(null);
            }}
          />
          <span className="text-xs text-muted">
            {load.settings.hasSearchKey ? "服务端已保存搜索 Key（不会回显）。" : "服务端当前没有搜索 Key。"}
          </span>
        </label>

        {canEdit ? null : (
          <p className="m-0 text-sm text-danger" role="alert">
            当前账号没有修改权限；请让服务端管理员在 <code>ADMIN_EMAIL</code> 里加入你的邮箱。
          </p>
        )}

        {notice === null ? null : (
          <p
            className={`m-0 text-sm ${notice.tone === "success" ? "text-success" : "text-danger"}`}
            role="status"
            data-testid="llm-settings-notice"
          >
            {notice.text}
          </p>
        )}

        <div>
          <button
            type="button"
            data-testid="llm-save"
            className="min-h-[44px] rounded-sm bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!canEdit || busy}
            onClick={save}
          >
            {busy ? "应用中…" : "保存并立即生效"}
          </button>
        </div>
      </section>

      <section className="mt-3 rounded-md border border-line bg-bg p-3 text-sm text-muted">
        <h2 className="m-0 text-sm font-semibold text-ink">四种模式是什么</h2>
        <ul className="m-0 mt-1 list-disc pl-5">
          <li><strong>live</strong>：真实调用上游，花钱、需要 Key。</li>
          <li><strong>record</strong>：真实调用并把结果录成回放文件。</li>
          <li><strong>replay</strong>：只读已有录像，不联网；没录到的需求会明确报错。</li>
          <li><strong>mock</strong>：内置演示数据，不联网，只用于演示链路。</li>
        </ul>
      </section>
    </main>
  );
}
