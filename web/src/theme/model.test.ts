import { describe, expect, it } from "vitest";

import {
  THEME_PREFERENCES,
  nextPreference,
  parseThemePreference,
  preferenceLabel,
  resolveTheme,
} from "./model";

describe("parseThemePreference", () => {
  it("只认三个值，其余（含 null、脏数据）一律当 system", () => {
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("DARK")).toBe("system");
    expect(parseThemePreference("{\"theme\":\"dark\"}")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("手动选择优先于系统偏好", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("system 时跟随系统，两个方向都要对", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("nextPreference", () => {
  it("三态循环：system → light → dark → system（能回到跟随系统）", () => {
    expect(nextPreference("system")).toBe("light");
    expect(nextPreference("light")).toBe("dark");
    expect(nextPreference("dark")).toBe("system");
  });

  it("循环三次回到原点，说明没有状态被跳过", () => {
    let current: (typeof THEME_PREFERENCES)[number] = THEME_PREFERENCES[0];
    for (let index = 0; index < THEME_PREFERENCES.length; index += 1) {
      current = nextPreference(current);
    }
    expect(current).toBe("system");
  });
});

describe("preferenceLabel", () => {
  it("三种偏好各有可读标签，且都带「主题」前缀", () => {
    for (const preference of THEME_PREFERENCES) {
      expect(preferenceLabel(preference)).toContain("主题");
    }
    expect(preferenceLabel("system")).toBe("主题：跟随系统");
    expect(preferenceLabel("dark")).toBe("主题：深色");
  });
});
