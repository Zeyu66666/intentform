/**
 * 字节流 → 文本流的解码器（薄封装，但必须单测）。
 *
 * 单独成文件的原因：`TextDecoder` 的 `{ stream: true }` 选项是**唯一**能正确处理
 * "UTF-8 多字节字符被 chunk 边界切断"的方式。中文需求、中文题干、KaTeX 里的
 * 全角符号都会踩到这条：`二次函数` 的 9 个字节可能被拆成 4 + 5 两块，
 * 忘记 `stream: true` 就会在中间取出两个 U+FFFD，而这类 bug 只在中文输入下复现。
 *
 * 流结束时必须再调一次 `decode()`（不带入参）把解码器内部残留的半个字符吐出来，
 * 否则尾部字符会静默丢失。
 */

export interface TextStreamDecoder {
  /** 解码一块字节；不完整的多字节序列会留在内部等待下一块。 */
  push(chunk: Uint8Array): string;
  /** 收尾：吐出内部残留。 */
  flush(): string;
}

export function createTextStreamDecoder(): TextStreamDecoder {
  const decoder = new TextDecoder("utf-8");

  return {
    push(chunk: Uint8Array): string {
      return decoder.decode(chunk, { stream: true });
    },
    flush(): string {
      return decoder.decode();
    },
  };
}
