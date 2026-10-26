/**
 * @intentform/web — 前端运行时配置解析。
 *
 * I0 只固化与部署强相关的两个决定，避免 I3 再回头改基础设施：
 *   1. 前端零 Key：这里只可能出现 API 相对路径，不允许任何密钥变量；
 *   2. API 基址默认同源，本地开发由 Vite 代理，部署时也不跨域。
 */

/** 允许注入的公共环境变量白名单。新增变量必须同时改这里和 `.env.example`。 */
export const PUBLIC_ENV_KEYS = ["VITE_API_BASE"] as const;

export type PublicEnvKey = (typeof PUBLIC_ENV_KEYS)[number];

export const DEFAULT_API_BASE = "/api";

export interface WebRuntimeConfig {
  readonly apiBase: string;
  /** 学生填写页路由前缀，发布短链形如 `/f/<slug>`。 */
  readonly fillPathPrefix: "/f";
}

/**
 * 解析 API 基址。
 * 空值 → 默认 `/api`；带协议的外部地址 → 抛错（同源策略由基础设施保证，
 * 不允许前端配置把请求发到第三方域，避免把 session cookie 泄露出去）。
 */
export function resolveApiBase(raw: string | undefined): string {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_API_BASE;
  if (/^[a-z]+:\/\//i.test(value)) {
    throw new Error(`VITE_API_BASE must be a same-origin path, got: ${value}`);
  }
  return value.startsWith("/") ? value.replace(/\/+$/, "") : `/${value.replace(/\/+$/, "")}`;
}

export function readWebConfig(env: Readonly<Record<string, string | undefined>>): WebRuntimeConfig {
  return {
    apiBase: resolveApiBase(env["VITE_API_BASE"]),
    fillPathPrefix: "/f",
  };
}
