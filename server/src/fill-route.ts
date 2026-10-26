/**
 * 学生端收集页：`GET /f/:slug`。
 *
 * 这个文件是本作品最需要被盯着看的一个文件，规则只有一条：
 *
 * > **同一个响应里只能出现一次 `publicView` 的结果变量，绝不能出现解析后的
 * > `schema`。** 落库的 `schema_json` 解出来就立刻交给 `publicView`，之后
 * > 变量作用域里只剩脱敏视图。`scripts/verify.mjs` 的 VC3 会从**字节层面**
 * > 检查响应体不含 `answer` / `explanation` / `bloom` / `knowledgePoint` /
 * > `objectives`，所以「顺手多返回一个字段」这种事故会在 CI 里当场爆掉。
 *
 * 另一个容易忘的点：没发布、或 slug 不存在的表单一律 404，且**两种情况的响应体
 * 完全一样**，否则可以用它探测「这个 slug 存在但还没发布」。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formSchema, publicView, type FillViewResponse } from "@intentform/schema";
import { findPublishedFormBySlug, findVersion } from "./db/forms.ts";
import { sendApiError, sendJson, type RouteContext } from "./http.ts";

/** 生产同源部署时，`/f/:slug` 的 document 请求（浏览器直接打开）需要一张 HTML 壳。 */
const WEB_INDEX_CANDIDATES: readonly string[] = [
  join(process.cwd(), "web", "dist", "index.html"),
  join(process.cwd(), "..", "web", "dist", "index.html"),
];

function wantsHtml(req: RouteContext["req"]): boolean {
  const accept = req.headers.accept;
  if (accept === undefined) return false;
  return accept.includes("text/html");
}

/** `WEB_INDEX_HTML` 显式指定时只认那一个路径（部署/测试都需要可预测）。 */
function indexCandidates(env: RouteContext["env"]): readonly string[] {
  if (env.webIndexHtml !== "") return [env.webIndexHtml];
  return WEB_INDEX_CANDIDATES;
}

function readIndexHtml(env: RouteContext["env"]): string | undefined {
  for (const candidate of indexCandidates(env)) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return undefined;
}

export async function handleFillView(ctx: RouteContext): Promise<void> {
  const slug = ctx.params["slug"];
  if (slug === undefined || slug === "") {
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  // 浏览器直接打开 /f/:slug 要的是页面，脚本要的是数据。同一个 URL 两种表述，
  // 靠 Accept 分流：生产由这里托管 SPA 壳，开发期由 vite 的 proxy bypass 截走。
  if (wantsHtml(ctx.req)) {
    const html = readIndexHtml(ctx.env);
    if (html === undefined) {
      // 缺产物时回 **JSON**（与其它错误一致的 `{ok,error,message}`），不吐栈、不回
      // 半张 HTML：前端拿到它就能把「构建没跑」这件事显示成人话，而不是白屏。
      sendApiError(
        ctx.res,
        "not_found",
        "未找到前端构建产物：先在 web 包执行 pnpm build，或用 WEB_INDEX_HTML 指定 index.html",
      );
      return;
    }
    ctx.res.statusCode = 200;
    ctx.res.setHeader("content-type", "text/html; charset=utf-8");
    ctx.res.setHeader("cache-control", "no-store");
    ctx.res.end(html);
    return;
  }

  const form = findPublishedFormBySlug(ctx.db, slug);
  if (form === undefined || form.published_version_id === null) {
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  const version = findVersion(ctx.db, form.id, form.published_version_id);
  if (version === undefined) {
    // 指针指向不存在的版本属于数据损坏，对外仍然是 404（不泄漏内部状态）。
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  const schema = formSchema.safeParse(parsed);
  if (!schema.success) {
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  // ↓ 全文件唯一一次 publicView；之后 schema 变量不再被引用。
  const view = publicView(schema.data);
  const response: FillViewResponse = {
    ok: true,
    formId: form.id,
    versionId: version.id,
    versionN: version.n,
    slug,
    form: view,
  };
  sendJson(ctx.res, 200, response);
}
