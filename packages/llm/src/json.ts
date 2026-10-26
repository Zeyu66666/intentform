/**
 * 无依赖的 JSON 取值小工具。
 *
 * 存在的理由：`noUncheckedIndexedAccess` + `unknown` 让「安全地读一个字段」变成
 * 5 行样板，而这件事在 provider / replay / validate 里要重复几十次。集中在这里，
 * 所有调用点都变成一行，且都不需要 `as`。
 */

export type JsonRecord = Readonly<Record<string, unknown>>;

export type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export function tryParseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 对象（不含 null 与数组）。 */
export function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

export function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readArray(record: JsonRecord, key: string): readonly unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}
