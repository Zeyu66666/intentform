/**
 * 把上游 delta 拼成的**字节流**切成行。
 *
 * 三个必须由它一个人负责的坑（分散到调用方去处理必然漏）：
 *
 * 1. **chunk 任意位置切断一行**：上游按 token 边界吐 delta，一行 NDJSON 被切成
 *    两三段是常态，所以必须留 residue 到下一块拼。
 * 2. **UTF-8 多字节字符被切断**：一个汉字 3 字节，一条中文行被切成「半个汉字」
 *    是高频事件。绝不能对每块 Buffer 各自 `toString()` —— 那样半个汉字会变成
 *    两个 `U+FFFD`，而且**这一行仍然是合法 JSON**（替换字符跑在字符串里），
 *    前端只会看到莫名其妙的乱码，排查成本极高。这里统一用
 *    `TextDecoder(..., { stream: true })`，跨块保留半个字符的字节。
 * 3. **`\r\n` 与 `\n` 混用、空行、末尾无换行的残留**：SSE 用空行分帧，NDJSON
 *    用空行无害，所以默认丢弃空行；`\r` 单独出现（旧 Mac 换行 / 手改文件）
 *    不会推进缓冲，直到下一个 `\n` 才切行——最后一块再由 `flush()` 兜底。
 *
 * 行内容原样返回，不做 trim、不解析：谁消费谁决定语义。
 */

import { TextDecoder } from "node:util";

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

export interface LineSplitterOptions {
  /**
   * 是否把空行当一行返回。SSE 分帧要靠空行触发 dispatch，所以 provider 用 `true`；
   * NDJSON 逐行校验用默认 `false`（空行没有任何语义）。
   */
  readonly keepEmptyLines?: boolean;
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export class LineSplitter {
  readonly #decoder: TextDecoder;

  readonly #keepEmptyLines: boolean;

  #buffer = "";

  constructor(options: LineSplitterOptions = {}) {
    // `fatal: false`：非法 UTF-8 由解码器替换成 U+FFFD 而不是抛错。整条链路是
    // 「上游说错话也要撑住」的容错语义，一个坏字节不值得让整次生成失败。
    this.#decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
    this.#keepEmptyLines = options.keepEmptyLines ?? false;
  }

  /** 尚未成行的残留文本（不含已消费行）。测试与诊断用。 */
  get pending(): string {
    return this.#buffer;
  }

  /**
   * 喂一块数据，返回这次**新凑齐**的完整行（不含换行符）。
   *
   * 接收 `Uint8Array` 或 `string`：生产链路是字节（`ReadableStreamDefaultReader`
   * 给的就是 `Uint8Array`），回放是字符串（fixture 里存的是解码后的 delta），
   * 两种输入共用同一套切行逻辑，避免出现「回放走另一条解析路径」这种分叉。
   */
  push(chunk: Uint8Array | string): readonly string[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    if (text === "") return [];
    this.#buffer += text;

    const lines: string[] = [];
    let index = this.#buffer.indexOf("\n");
    while (index !== -1) {
      const raw = stripTrailingCarriageReturn(this.#buffer.slice(0, index));
      this.#buffer = this.#buffer.slice(index + 1);
      if (raw !== "" || this.#keepEmptyLines) lines.push(raw);
      index = this.#buffer.indexOf("\n");
    }
    return lines;
  }

  /**
   * 流结束：把解码器里残留的半个字符逼出来，并返回最后一行（如果有）。
   *
   * 注意「最后一行没有换行」是合法输入（上游可能就这样断流），所以要返回它；
   * 而「最后只有一个换行」返回空数组。
   */
  flush(): readonly string[] {
    this.#buffer += this.#decoder.decode();
    const rest = this.#buffer;
    this.#buffer = "";
    if (rest === "") return [];
    const line = stripTrailingCarriageReturn(rest);
    if (line === "" && !this.#keepEmptyLines) return [];
    return [line];
  }

  /** 重置到初始状态（测试里换一份输入时用，避免新建对象）。 */
  reset(): void {
    this.#buffer = "";
    this.#decoder.decode();
  }
}

/** 便捷判定：一行是否是空的（只有空白也算空）。 */
export function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

/** 供个别调用方判断「这块数据里是否有换行」——不参与切行，只是廉价探测。 */
export function containsLineFeed(chunk: Uint8Array): boolean {
  return chunk.includes(LINE_FEED) || chunk.includes(CARRIAGE_RETURN);
}
