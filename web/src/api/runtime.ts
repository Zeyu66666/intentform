/**
 * 只读的服务端运行信息（`GET /healthz`）。
 *
 * 为什么单独一条：生成页是匿名可用的，而 `/api/settings/llm` 要登录。
 * 「联网参考只在 live 生效」这个开关的禁用态需要一个**不涉及密钥**的模式值，
 * `/healthz` 本来就公开回 `llmMode`（评审用它确认当前跑的是回放还是真实上游）。
 *
 * 读不到就回 `null`：界面据此显示「未知」，不猜、不默认成 live。
 */

const HEALTHZ_PATH = "/healthz";

export type RuntimeFetch = (url: string, init?: { readonly headers?: Readonly<Record<string, string>> }) => Promise<{
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
}>;

/** 返回服务端当前 `llmMode`；网络失败/形状不符一律 `null`。 */
export async function readRuntimeMode(fetchImpl: RuntimeFetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(HEALTHZ_PATH, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const payload = await response.json();
    if (typeof payload !== "object" || payload === null) return null;
    const mode = (payload as Record<string, unknown>)["llmMode"];
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}
