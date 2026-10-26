import { describe, expect, it } from "vitest";

import { UNKNOWN_TEXT, formatDateTime, formatScoreNumber } from "./format";

describe("formatDateTime", () => {
  it("本地时间按 YYYY-MM-DD HH:mm 输出（不带时区的手写串解析成本地时间，跨时区确定性可测）", () => {
    expect(formatDateTime("2024-05-01T08:30:00")).toBe("2024-05-01 08:30");
    expect(formatDateTime("2024-12-31T23:05:00")).toBe("2024-12-31 23:05");
  });

  it("带 Z 的 UTC 串也给出同一形状（具体时刻随宿主时区变化，所以只断言形状）", () => {
    expect(formatDateTime("2024-05-01T00:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("解析不了就给占位符，不抛错也不编时间", () => {
    expect(formatDateTime("")).toBe(UNKNOWN_TEXT);
    expect(formatDateTime("not-a-date")).toBe(UNKNOWN_TEXT);
  });
});

describe("formatScoreNumber", () => {
  it("整数不带小数点，非整数保留一位", () => {
    expect(formatScoreNumber(0)).toBe("0");
    expect(formatScoreNumber(10)).toBe("10");
    expect(formatScoreNumber(3.5)).toBe("3.5");
    expect(formatScoreNumber(3.46)).toBe("3.5");
  });

  it("非有限数给占位符", () => {
    expect(formatScoreNumber(Number.NaN)).toBe(UNKNOWN_TEXT);
    expect(formatScoreNumber(Number.POSITIVE_INFINITY)).toBe(UNKNOWN_TEXT);
  });
});
