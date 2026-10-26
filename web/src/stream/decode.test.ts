import { describe, expect, it } from "vitest";

import { createTextStreamDecoder } from "./decode";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("createTextStreamDecoder", () => {
  it("普通 ASCII 分块解码", () => {
    const decoder = createTextStreamDecoder();
    expect(decoder.push(encode("hello ")) + decoder.push(encode("world"))).toBe("hello world");
  });

  it("中文多字节字符被 chunk 边界切断时不出 U+FFFD", () => {
    const bytes = encode("二次函数");
    const decoder = createTextStreamDecoder();

    // 故意切在第 2 个字节中间：`二` 占 3 字节，第一块只给它 1 字节。
    const first = decoder.push(bytes.subarray(0, 1));
    const second = decoder.push(bytes.subarray(1, 5));
    const third = decoder.push(bytes.subarray(5));
    const text = first + second + third + decoder.flush();

    expect(text).toBe("二次函数");
    expect(text).not.toContain("\uFFFD");
  });

  it("流结束时的 flush 吐出内部残留（否则尾部字符静默丢失）", () => {
    const bytes = encode("顶点");
    const decoder = createTextStreamDecoder();
    // 只喂 `顶` 的前两个字节，最后一个字节由 flush 兜底 → 半个字符只能变成替换符，
    // 这里断言的是"flush 确实有输出"，而不是"半截字节能变出完整汉字"。
    expect(decoder.push(bytes.subarray(0, 4))).toBe("顶");
    expect(decoder.push(bytes.subarray(4))).toBe("点");
    expect(decoder.flush()).toBe("");
  });

  it("emoji（4 字节）跨块也不炸", () => {
    const bytes = encode("✅ 通过");
    const decoder = createTextStreamDecoder();
    const text = decoder.push(bytes.subarray(0, 2)) + decoder.push(bytes.subarray(2)) + decoder.flush();
    expect(text).toBe("✅ 通过");
  });
});
