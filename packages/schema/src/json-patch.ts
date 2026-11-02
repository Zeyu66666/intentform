/**
 * 通用 JSON Patch（RFC 6902 子集）——**语法通用，落库仍受限**。
 *
 * 《计划-v3.1》§2.2 原先把「通用 JSON Patch」列为不做。负责人在 2026-11-02
 * 明确把它拉进范围，但选的是「语法接受 RFC 6902，落库前仍过 applyPatch」：
 *
 * 1. 路径只允许落在 `/items/<下标>/<字段>` 及其选项/答案子路径，改不了 meta、
 *    题目数量、题目 id、题型；
 * 2. 应用完先过 `formSchema`，再逐字段翻译回现有的十一个 op，最后用
 *    `applyPatch` 重放一遍；两边结果不一致就整包拒绝。
 *
 * 这样接口能收 `add/remove/replace/move/copy/test`，但「受限修改」的安全边界
 * （答案不泄漏、单题作用域、diff 可读、版本可撤销）一个都没丢。
 */

import { z } from "zod";

import { LIMITS } from "./constants.ts";
import { applyPatch, type PatchOp } from "./patch.ts";
import { formSchema, type FormItem, type FormSchema } from "./types.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const base = { path: z.string() };

/** RFC 6902 的六种操作。`value` 只出现在 add/replace/test，`from` 只出现在 move/copy。 */
export const jsonPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), ...base, value: jsonValueSchema }).strict(),
  z.object({ op: z.literal("remove"), ...base }).strict(),
  z.object({ op: z.literal("replace"), ...base, value: jsonValueSchema }).strict(),
  z.object({ op: z.literal("move"), ...base, from: z.string() }).strict(),
  z.object({ op: z.literal("copy"), ...base, from: z.string() }).strict(),
  z.object({ op: z.literal("test"), ...base, value: jsonValueSchema }).strict(),
]);

export type JsonPatchOp = z.infer<typeof jsonPatchOpSchema>;

export const jsonPatchOpsSchema = z.array(jsonPatchOpSchema).min(1).max(LIMITS.fieldsMax);

export type JsonPatchErrorCode =
  | "json_patch_invalid_path"
  | "json_patch_path_missing"
  | "json_patch_test_failed"
  | "json_patch_unsupported_path"
  | "json_patch_structure_locked"
  | "json_patch_schema_invalid"
  | "json_patch_unsupported_change";

export interface JsonPatchError {
  readonly opIndex: number;
  readonly code: JsonPatchErrorCode;
  readonly message: string;
}

export type JsonPatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly JsonPatchError[] };

function fail<T>(opIndex: number, code: JsonPatchErrorCode, message: string): JsonPatchResult<T> {
  return { ok: false, errors: [{ opIndex, code, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 文档只来自 Schema JSON，JSON 往返即可得到无别名的深拷贝。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/** 解析 JSON Pointer；`~1` 是 `/`，`~0` 是 `~`。非法转义直接拒绝。 */
function parsePointer(path: string): string[] | null {
  if (path === "") return [];
  if (!path.startsWith("/")) return null;
  const tokens = path.slice(1).split("/");
  const decoded: string[] = [];
  for (const token of tokens) {
    if (/~(?:[^01]|$)/u.test(token)) return null;
    decoded.push(token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  }
  return decoded;
}

function parseIndex(token: string, length: number, allowEnd: boolean): number | null {
  if (token === "-") return allowEnd ? length : null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return null;
  const index = Number(token);
  const max = allowEnd ? length : length - 1;
  return index <= max ? index : null;
}

function readAt(document: unknown, tokens: readonly string[]): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = parseIndex(token, current.length, false);
      if (index === null) return { found: false };
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, token)) {
      return { found: false };
    }
    current = current[token];
  }
  return { found: true, value: current };
}

function writeAt(document: unknown, tokens: readonly string[], value: unknown, mode: "add" | "replace"): boolean {
  if (tokens.length === 0) return false; // 根替换由调用方单独处理
  const parentTokens = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1] as string;
  const parent = readAt(document, parentTokens);
  if (!parent.found) return false;

  if (Array.isArray(parent.value)) {
    const index = parseIndex(last, parent.value.length, mode === "add");
    if (index === null) return false;
    if (mode === "add") parent.value.splice(index, 0, value);
    else parent.value[index] = value;
    return true;
  }
  if (!isRecord(parent.value)) return false;
  if (mode === "replace" && !Object.prototype.hasOwnProperty.call(parent.value, last)) return false;
  parent.value[last] = value;
  return true;
}

function removeAt(document: unknown, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const parentTokens = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1] as string;
  const parent = readAt(document, parentTokens);
  if (!parent.found) return false;

  if (Array.isArray(parent.value)) {
    const index = parseIndex(last, parent.value.length, false);
    if (index === null) return false;
    parent.value.splice(index, 1);
    return true;
  }
  if (!isRecord(parent.value) || !Object.prototype.hasOwnProperty.call(parent.value, last)) return false;
  delete parent.value[last];
  return true;
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length < path.length && prefix.every((token, index) => token === path[index]);
}

/**
 * 在文档副本上依次应用 RFC 6902 操作。`test` 只读；任一步失败返回错误，
 * 调用方拿不到「改了一半」的文档。
 */
export function applyJsonPatch<T>(document: T, ops: readonly JsonPatchOp[]): JsonPatchResult<T> {
  let current = clone(document) as unknown;

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as JsonPatchOp;
    const tokens = parsePointer(op.path);
    if (tokens === null) return fail(i, "json_patch_invalid_path", `#${String(i)} path 不是合法 JSON Pointer`);

    if (op.op === "test") {
      const found = readAt(current, tokens);
      if (!found.found) return fail(i, "json_patch_path_missing", `#${String(i)} test 路径不存在：${op.path}`);
      if (!deepEqual(found.value, op.value)) {
        return fail(i, "json_patch_test_failed", `#${String(i)} test 不成立：${op.path}`);
      }
      continue;
    }

    if (op.op === "add") {
      if (tokens.length === 0) {
        current = clone(op.value);
        continue;
      }
      if (!writeAt(current, tokens, clone(op.value), "add")) {
        return fail(i, "json_patch_path_missing", `#${String(i)} add 的父路径不存在：${op.path}`);
      }
      continue;
    }

    if (op.op === "replace") {
      if (tokens.length === 0) {
        current = clone(op.value);
        continue;
      }
      if (!writeAt(current, tokens, clone(op.value), "replace")) {
        return fail(i, "json_patch_path_missing", `#${String(i)} replace 的目标不存在：${op.path}`);
      }
      continue;
    }

    if (op.op === "remove") {
      if (!removeAt(current, tokens)) {
        return fail(i, "json_patch_path_missing", `#${String(i)} remove 的目标不存在：${op.path}`);
      }
      continue;
    }

    const fromTokens = parsePointer(op.from);
    if (fromTokens === null) {
      return fail(i, "json_patch_invalid_path", `#${String(i)} from 不是合法 JSON Pointer`);
    }
    const source = readAt(current, fromTokens);
    if (!source.found) {
      return fail(i, "json_patch_path_missing", `#${String(i)} from 路径不存在：${op.from}`);
    }
    if (op.op === "move") {
      if (deepEqual(fromTokens, tokens)) continue;
      if (isPrefix(fromTokens, tokens)) {
        return fail(i, "json_patch_invalid_path", `#${String(i)} 不能把值移动到自己的子路径`);
      }
      if (!removeAt(current, fromTokens)) {
        return fail(i, "json_patch_path_missing", `#${String(i)} move 的 from 不存在：${op.from}`);
      }
      if (tokens.length === 0) {
        current = clone(source.value);
      } else if (!writeAt(current, tokens, source.value, "add")) {
        return fail(i, "json_patch_path_missing", `#${String(i)} move 的目标父路径不存在：${op.path}`);
      }
      continue;
    }
    // copy
    if (tokens.length === 0) {
      current = clone(source.value);
    } else if (!writeAt(current, tokens, clone(source.value), "add")) {
      return fail(i, "json_patch_path_missing", `#${String(i)} copy 的目标父路径不存在：${op.path}`);
    }
  }

  return { ok: true, value: current as T };
}

/* ------------------------- RFC 6902 → 受限 op 的翻译 ------------------------- */

/** 允许写入的路径：只到题目字段，以及选项/答案的必要子路径。 */
const ITEM_FIELD_PATH =
  /^\/items\/(?:0|[1-9][0-9]*)\/(?:title|score|required|bloom|knowledgePoint|maxLength|explanation|description)$/u;
const OPTIONS_PATH =
  /^\/items\/(?:0|[1-9][0-9]*)\/options(?:\/(?:-|0|[1-9][0-9]*)(?:\/(?:id|text))?)?$/u;
const ANSWER_PATH =
  /^\/items\/(?:0|[1-9][0-9]*)\/answer(?:\/(?:-|0|[1-9][0-9]*)(?:\/(?:value|tolerance))?|\/(?:value|tolerance))?$/u;

function isAllowedWritePath(path: string): boolean {
  return ITEM_FIELD_PATH.test(path) || OPTIONS_PATH.test(path) || ANSWER_PATH.test(path);
}

/** 路径里的题目下标与字段名；只对允许的路径调用。 */
function parseItemPath(path: string): { readonly index: number; readonly field: string } | null {
  const match = /^\/items\/(0|[1-9][0-9]*)\/([^/]+)/u.exec(path);
  if (match === null) return null;
  return { index: Number(match[1]), field: match[2] as string };
}

/**
 * 路径与题型匹配检查。放在 apply 之前，让「给分节改必答」这类错误报在
 * 具体那一条 op 上，而不是等翻译完才在 applyPatch 里变成一条笼统的 400。
 */
function pathAllowedForItem(path: string, item: FormItem): boolean {
  const parsed = parseItemPath(path);
  if (parsed === null) return false;
  switch (parsed.field) {
    case "title":
      return true;
    case "score":
      return item.type === "single" || item.type === "multi" || item.type === "fill" || item.type === "number" || item.type === "short";
    case "options":
      return item.type === "single" || item.type === "multi";
    case "answer":
      return item.type === "single" || item.type === "multi" || item.type === "fill" || item.type === "number";
    case "description":
      return item.type === "section";
    case "explanation":
      return item.type !== "section" && item.type !== "scale";
    case "required":
      return item.type !== "section";
    case "bloom":
    case "knowledgePoint":
      return item.type !== "scale" && item.type !== "section";
    case "maxLength":
      return item.type === "short";
    default:
      return false;
  }
}

function answerPayloadOf(item: FormItem): PatchOp | null {
  switch (item.type) {
    case "single":
      return item.answer === undefined ? null : { op: "setAnswer", itemId: item.id, answer: { type: "single", answer: item.answer } };
    case "multi":
      return item.answer === undefined
        ? null
        : { op: "setAnswer", itemId: item.id, answer: { type: "multi", answer: [...item.answer] } };
    case "fill":
      return item.answer === undefined
        ? null
        : { op: "setAnswer", itemId: item.id, answer: { type: "fill", answer: [...item.answer] } };
    case "number":
      return item.answer === undefined
        ? null
        : { op: "setAnswer", itemId: item.id, answer: { type: "number", answer: { ...item.answer } } };
    default:
      return null;
  }
}

export type JsonPatchTranslation =
  | { readonly ok: true; readonly ops: readonly PatchOp[] }
  | { readonly ok: false; readonly errors: readonly JsonPatchError[] };

function translationFail(
  opIndex: number,
  code: JsonPatchErrorCode,
  message: string,
): JsonPatchTranslation {
  return { ok: false, errors: [{ opIndex, code, message }] };
}

/** 只有这五种题型带 `explanation`；分节用 `description`，量表两者都没有。 */
function hasExplanation(item: FormItem): item is Extract<FormItem, { type: "single" | "multi" | "fill" | "number" | "short" }> {
  return item.type !== "section" && item.type !== "scale";
}

/**
 * 把一份 RFC 6902 补丁翻译成受限 op 序列。
 *
 * 翻译不是「只认 replace」：选项数组上的 add/remove/move 会先真正作用到 JSON，
 * 再作为整组 `setOptions` 落库——所以通用语法与可读 diff 可以同时成立。
 */
export function translateJsonPatch(input: FormSchema, ops: readonly JsonPatchOp[]): JsonPatchTranslation {
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as JsonPatchOp;
    if (op.op === "test") continue; // 只读，允许 test 任意路径
    if (!isAllowedWritePath(op.path)) {
      return translationFail(i, "json_patch_unsupported_path", `#${String(i)} 只能改题目字段，不能改 ${op.path}`);
    }
    const parsed = parseItemPath(op.path);
    if (parsed === null || input.items[parsed.index] === undefined) {
      return translationFail(i, "json_patch_unsupported_path", `#${String(i)} 题目下标不存在：${op.path}`);
    }
    const item = input.items[parsed.index] as FormItem;
    if (!pathAllowedForItem(op.path, item)) {
      return translationFail(i, "json_patch_unsupported_path", `#${String(i)} 第 ${String(parsed.index + 1)} 题不支持字段 ${parsed.field}`);
    }
    if (op.op === "move" || op.op === "copy") {
      const fromParsed = parseItemPath(op.from);
      if (!isAllowedWritePath(op.from) || fromParsed === null || input.items[fromParsed.index] === undefined) {
        return translationFail(i, "json_patch_unsupported_path", `#${String(i)} from 只能指向题目字段：${op.from}`);
      }
      if (!pathAllowedForItem(op.from, input.items[fromParsed.index] as FormItem)) {
        return translationFail(i, "json_patch_unsupported_path", `#${String(i)} from 指向的字段与题型不匹配：${op.from}`);
      }
    }
  }

  const applied = applyJsonPatch(input, ops);
  if (!applied.ok) return { ok: false, errors: applied.errors };

  const parsed = formSchema.safeParse(applied.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? "根" : first.path.join(".");
    return translationFail(
      ops.length - 1,
      "json_patch_schema_invalid",
      `${where}：${first?.message ?? "修改后的表单结构不合法"}`,
    );
  }
  const next = parsed.data as FormSchema;

  if (!deepEqual(next.meta, input.meta)) {
    return translationFail(ops.length - 1, "json_patch_unsupported_change", "通用 Patch 不能改表单元信息（标题/类型/总分）");
  }
  if (next.items.length !== input.items.length) {
    return translationFail(ops.length - 1, "json_patch_structure_locked", "通用 Patch 不能增删题目");
  }

  const translated: PatchOp[] = [];
  for (let index = 0; index < next.items.length; index += 1) {
    const before = input.items[index] as FormItem;
    const after = next.items[index] as FormItem;
    if (before.id !== after.id || before.type !== after.type) {
      return translationFail(ops.length - 1, "json_patch_structure_locked", "通用 Patch 不能改题目 id 或题型");
    }

    if (before.title !== after.title) {
      translated.push({ op: "setStem", itemId: after.id, title: after.title });
    }
    if ("score" in before && "score" in after && before.score !== after.score) {
      translated.push({ op: "setScore", itemId: after.id, score: after.score ?? 0 });
    }
    if (
      (before.type === "single" || before.type === "multi") &&
      (after.type === "single" || after.type === "multi") &&
      !deepEqual(before.options, after.options)
    ) {
      translated.push({ op: "setOptions", itemId: after.id, options: [...after.options] });
    }
    const beforeAnswer = answerPayloadOf(before);
    const afterAnswer = answerPayloadOf(after);
    if (!deepEqual(beforeAnswer, afterAnswer)) {
      if (afterAnswer === null) {
        return translationFail(ops.length - 1, "json_patch_unsupported_change", `第 ${String(index + 1)} 题不能删除答案`);
      }
      translated.push(afterAnswer);
    }
    if (before.type === "section" && after.type === "section" && before.description !== after.description) {
      translated.push({ op: "setExplanation", itemId: after.id, explanation: after.description ?? null });
    }
    if (hasExplanation(before) && hasExplanation(after) && before.explanation !== after.explanation) {
      translated.push({ op: "setExplanation", itemId: after.id, explanation: after.explanation ?? null });
    }
    if (before.type !== "section" && after.type !== "section" && before.required !== after.required) {
      translated.push({ op: "setRequired", itemId: after.id, required: after.required });
    }
    if (before.type !== "scale" && before.type !== "section" && after.type !== "scale" && after.type !== "section") {
      const bloom = after.bloom ?? null;
      const knowledgePoint = after.knowledgePoint ?? null;
      if ((before.bloom ?? null) !== bloom || (before.knowledgePoint ?? null) !== knowledgePoint) {
        translated.push({ op: "setMeta", itemId: after.id, bloom, knowledgePoint });
      }
    }
    if (before.type === "short" && after.type === "short" && before.maxLength !== after.maxLength) {
      translated.push({ op: "setMaxLength", itemId: after.id, maxLength: after.maxLength });
    }
  }

  // 最后一道对账：翻译出的 op 重放结果必须与 JSON Patch 的结果逐字节一致。
  const check = applyPatch(input, translated);
  if (!check.ok) {
    return translationFail(
      ops.length - 1,
      "json_patch_unsupported_change",
      `这份改动无法由受限 op 表达：${check.errors[0]?.message ?? "未知原因"}`,
    );
  }
  // `totalScore` 由 applyPatch 按题目分值重算，JSON Patch 里的旧值不算差异：
  // 通用 Patch 改的是题目，总分是派生字段，不能让一份合法补丁因为总分没跟着写而死掉。
  const comparable = (schema: FormSchema): FormSchema => ({
    ...schema,
    meta: { ...schema.meta, totalScore: 0 },
  });
  if (!deepEqual(comparable(check.schema), comparable(next))) {
    return translationFail(ops.length - 1, "json_patch_unsupported_change", "这份改动无法由受限 op 等价表达");
  }

  return { ok: true, ops: translated };
}
