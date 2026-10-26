import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { LineSplitter } from "./line-splitter.ts";

describe("LineSplitter", () => {
  it("把被任意位置切断的一行拼回去", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"type":"se')).toEqual([]);
    expect(splitter.push('ction","id":"sec1"}')).toEqual([]);
    expect(splitter.push("\n")).toEqual(['{"type":"section","id":"sec1"}']);
    expect(splitter.pending).toBe("");
  });

  it("一次 push 里有多行时全部返回，末尾残留留在 pending", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b":2}\n{"c":')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.pending).toBe('{"c":');
  });

  it("UTF-8 多字节字符在字节边界被切断时不产生替换字符", () => {
    const text = `${JSON.stringify({ title: "二次函数开口方向" })}\n`;
    const bytes = Buffer.from(text, "utf8");
    // 逐字节喂：每个汉字（3 字节）都会被切在两块之间。
    const lines: string[] = [];
    const splitter = new LineSplitter();
    for (const byte of bytes) {
      lines.push(...splitter.push(Uint8Array.of(byte)));
    }
    expect(lines).toEqual([JSON.stringify({ title: "二次函数开口方向" })]);
    expect(lines.join("")).not.toContain("\uFFFD");
  });

  it("\\r\\n 与 \\n\\r 混用都切对行且不带回 \\r", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitter.push("c\r")).toEqual([]);
    // 空行没有语义，默认丢掉；`d` 还没换行，留在 pending。
    expect(splitter.push("\nd")).toEqual(["c"]);
    expect(splitter.pending).toBe("d");
    expect(splitter.flush()).toEqual(["d"]);
  });

  it("默认丢弃空行；keepEmptyLines 时把空行也当一行返回", () => {
    const plain = new LineSplitter();
    expect(plain.push("a\n\nb\n")).toEqual(["a", "b"]);

    const keep = new LineSplitter({ keepEmptyLines: true });
    expect(keep.push("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("末尾无换行的残留行由 flush() 兜底，且只兜一次", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"x":1}')).toEqual([]);
    expect(splitter.flush()).toEqual(['{"x":1}']);
    expect(splitter.flush()).toEqual([]);
    expect(splitter.pending).toBe("");
  });

  it("flush 会把未完成的半个字符按替换字符收尾（不抛错）", () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from("汉", "utf8");
    expect(splitter.push(bytes.subarray(0, 2))).toEqual([]);
    expect(splitter.flush()).toEqual(["\uFFFD"]);
  });
});
