/**
 * 主题偏好（省赛附加 A-19 暗色模式）：纯函数，不碰 DOM。
 *
 * 三种偏好：`system`（跟随系统，默认）/ `light` / `dark`。
 * 为什么要留 `system` 而不是只存亮/暗：第一次打开的人不该被应用替系统做主；
 * 但一旦手动选过，就以他的选择为准，系统变了也不改。
 *
 * 存储的是一个字符串——**坏值一律当 system**：localStorage 可能被别的东西写脏，
 * 抛错或把界面锁在全白是最差的结果。
 */

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = "light" | "dark";

/** 存偏好用的键；`readStoredPreference` 与 `useTheme` 必须用同一个。 */
export const THEME_STORAGE_KEY = "intentform.theme";

export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** 把偏好 + 系统偏好解析成实际主题。 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/**
 * 点一下按钮切到下一个偏好：system → light → dark → system。
 *
 * 三态循环而不是亮/暗开关：没有「回到跟随系统」的路径，用户一旦点过就再也
 * 找不回默认行为，而那正是大多数人想要的状态。
 */
export function nextPreference(current: ThemePreference): ThemePreference {
  switch (current) {
    case "system":
      return "light";
    case "light":
      return "dark";
    case "dark":
      return "system";
  }
}

/** 按钮上显示的一句话；`aria-label` 也用它，避免两处文案漂移。 */
export function preferenceLabel(preference: ThemePreference): string {
  switch (preference) {
    case "system":
      return "主题：跟随系统";
    case "light":
      return "主题：浅色";
    case "dark":
      return "主题：深色";
  }
}
