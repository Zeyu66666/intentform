/**
 * 展示用的格式化（纯函数）。
 *
 * 只在 `.ts` 里做，是因为这些规则有"看起来对但其实错"的陷阱：
 * `avgScore: null` 被 `?? 0` 兜成 `0`、"0 分"与"没人交"混为一谈、
 * ISO 时间直接 `slice(0, 10)` 得到 UTC 日期（教师看的是本地时间）。
 */

/** 无法解析的时间不编一个值出来。 */
export const UNKNOWN_TEXT = "—" as const;

/**
 * ISO 时间 → 本地「YYYY-MM-DD HH:mm」。
 *
 * 用浏览器本地时区：教师看的是自己墙上的时间。`toLocaleString` 会随系统语言变
 * （英文系统给出 `5/1/2024, 8:30 AM`），评审截图不统一，所以手工补零。
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNKNOWN_TEXT;

  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * 分数显示：整数不带小数点，非整数保留一位（平均分最常见的形状）。
 * 不做四舍五入到整数：3.5 与 4 在看板上是两件事。
 */
export function formatScoreNumber(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN_TEXT;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
