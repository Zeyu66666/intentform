/**
 * 主题应用到 DOM：`<html data-theme="light|dark">` + `color-scheme`。
 *
 * 为什么不直接用 Tailwind 的 `dark:` 变体：全站颜色都来自 `tokens.css` 的
 * CSS 变量（`tailwind.config.js` 只是把变量名接到工具类上），所以换主题只需要
 * 换一组变量值。加一套 `dark:` 类会让每个组件都有两份样式，和「6 个颜色、
 * 一处真相」的约定冲突。
 *
 * 三个细节：
 * 1. 首次渲染前就写 `data-theme`（`main.tsx` 里调 `applyStoredTheme()`），
 *    否则深色系统用户会先看到一帧白闪；
 * 2. 只有偏好是 `system` 时才监听 `prefers-color-scheme`；
 * 3. 写 localStorage 可能抛（隐私模式/配额），失败就只影响"下次记住"，不影响当下。
 */

import { useCallback, useEffect, useState } from "react";

import {
  THEME_STORAGE_KEY,
  nextPreference,
  parseThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "./model";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

export function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset["theme"] = theme;
  // 让原生控件（滚动条、输入框、日期选择器）跟着换，否则深色下会出现白控件。
  root.style.colorScheme = theme;
}

/** 启动时同步一次：在 React 渲染之前调用，避免白闪。 */
export function applyStoredTheme(): void {
  applyTheme(resolveTheme(readStoredPreference(), systemPrefersDark()));
}

export interface ThemeController {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  /** 切到下一个偏好（system → light → dark → system）。 */
  readonly cycle: () => void;
}

export function useTheme(): ThemeController {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "system" : readStoredPreference(),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // 只有跟随系统时才订阅系统变化；用户手动选过之后，系统切换不该覆盖他的选择。
  useEffect(() => {
    if (preference !== "system") return undefined;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [preference]);

  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const cycle = useCallback(() => {
    setPreference((current) => {
      const next = nextPreference(current);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // 记不住就算了：本次会话仍然生效（状态已经更新）。
      }
      return next;
    });
  }, []);

  return { preference, resolved, cycle };
}
