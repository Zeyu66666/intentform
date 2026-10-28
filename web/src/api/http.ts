/**
 * 唯一的 HTTP 出口。
 *
 * 三条规矩在这里落地，组件里不再重复：
 *   1. **写操作必带 CSRF 头** `x-intentform-csrf: 1`（服务端对 POST/PUT/PATCH/DELETE
 *      强制校验，缺了就 403）。头名与值是从契约里搬来的常量，不是各处手写字符串。
 *   2. **`credentials: "include"`**：鉴权靠 httpOnly session cookie，前端零 token、
 *      零 Key（`AGENTS.md` §5）。学生页同样带上——匿名填也走同一个客户端。
 *   3. **失败不抛异常**，返回 `ApiResult`：界面要区分 401/404/409/网络断开四种结局，
 *      抛异常会让调用方在 `catch` 里重新猜状态码。
 *
 * 路径直接用 `API_PATHS` 的返回值（已含 `/api` 前缀），不再拼接 `apiBase`：
 * 契约里的路径就是线缆上的路径，二次拼接只会拼出 `/api/api/...`。
 */

import { isApiErrorBody, type ApiErrorCode } from "@intentform/schema";

/** 与 `server` 的 CSRF 中间件约定的头；`submit.test.ts` 断言它确实出现在请求里。 */
export const CSRF_HEADER = "x-intentform-csrf" as const;
export const CSRF_HEADER_VALUE = "1" as const;

/** 连不上、被 CORS 挡下、被用户取消 —— 都没有状态码可用，统一这一句。 */
export const NETWORK_MESSAGE = "网络异常，请检查连接后重试" as const;
/** 拿到了 200 但响应体不是 JSON：属于契约违约，如实报，不假装成功。 */
export const BAD_RESPONSE_MESSAGE = "服务端返回了无法解析的响应" as const;

export interface ApiFailure {
  /** HTTP 状态码；`null` 表示请求根本没到达服务端。 */
  readonly status: number | null;
  /** 契约错误码；响应体不是 `ApiErrorBody` 时为 `null`。 */
  readonly code: ApiErrorCode | null;
  readonly message: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ApiFailure };

export interface HttpRequestOptions {
  /**
   * `PATCH` 只为「受限修改」加：服务端把 op 数组挂在 `PATCH /api/forms/:id` 上，
   * 用 `POST` 转发会让路径语义和权限校验都对不上。`DELETE` 至今没有落点，不提前开。
   */
  readonly method?: "GET" | "POST" | "PATCH";
  /** 有值才序列化并带 `Content-Type`；`undefined` 表示无请求体。 */
  readonly body?: unknown;
  /**
   * 是否附 CSRF 头。默认关：GET 不需要，而且浏览器对带自定义头的跨源请求
   * 会先发 `OPTIONS` 预检，无谓地多一跳。
   */
  readonly csrf?: boolean;
}

export interface HttpClient {
  readonly request: <T>(path: string, options?: HttpRequestOptions) => Promise<ApiResult<T>>;
}

export interface HttpClientOptions {
  readonly fetchImpl?: typeof fetch;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function failureFromStatus(status: number, payload: unknown): ApiFailure {
  if (isApiErrorBody(payload)) {
    return { status, code: payload.error, message: payload.message };
  }
  return { status, code: null, message: `请求失败（HTTP ${String(status)}）` };
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  // 注入点：测试用假 fetch，生产用浏览器的那个。
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async request<T>(path: string, requestOptions: HttpRequestOptions = {}): Promise<ApiResult<T>> {
      const headers: Record<string, string> = { Accept: "application/json" };
      const body = requestOptions.body;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (requestOptions.csrf === true) headers[CSRF_HEADER] = CSRF_HEADER_VALUE;

      let response: Response;
      try {
        response = await doFetch(path, {
          method: requestOptions.method ?? "GET",
          headers,
          credentials: "include",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // 区分不了"断网"与"被拦"，也不该假装分得清：给同一句可操作的提示。
        return { ok: false, failure: { status: null, code: null, message: NETWORK_MESSAGE } };
      }

      const payload = await readJson(response);

      if (!response.ok) {
        return { ok: false, failure: failureFromStatus(response.status, payload) };
      }
      if (payload === undefined) {
        return {
          ok: false,
          failure: { status: response.status, code: null, message: BAD_RESPONSE_MESSAGE },
        };
      }
      // 这里是唯一的类型断言：JSON 是 `unknown`，而形状由冻结契约（`api.ts`）保证。
      // 不在前端跑一遍 Zod：契约已冻结、服务端是事实源，重复校验只会让前端多一份
      // 会漂移的真相；真正需要区分的是 `ok:false` 的错误体，那个已经用类型守卫判过了。
      return { ok: true, data: payload as T };
    },
  };
}
