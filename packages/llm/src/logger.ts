/**
 * 可注入日志。
 *
 * 库里不打 `console.log`：库不知道自己跑在服务端、测试还是未来的 worker 里，
 * 也不知道日志该不该脱敏。这里只定义形状 + 两个实现，真正的落点（stderr / 结构化
 * 文件 / 采集器）由 server 决定。
 *
 * 默认实现写 `process.stderr` 并强制脱敏：诊断信息走 stderr 是 Unix 惯例，
 * 也不会污染 `/api/generate` 的 stdout 输出。
 */

import { redactSecrets, truncate } from "./errors.ts";

export type LogLevel = "info" | "warn" | "error";

export type LlmLogger = (level: LogLevel, message: string, detail?: string) => void;

/** 静默：单测与「库被当纯函数用」的场景默认用它。 */
export const silentLogger: LlmLogger = () => {};

export interface ConsoleLoggerOptions {
  /** 落点。默认 `process.stderr.write`。 */
  readonly write?: (line: string) => void;
  /** 需要按值打码的秘密（API Key）。形态匹配只是兜底。 */
  readonly secrets?: readonly string[];
  /** 是否输出 `info`。生产默认只留 warn/error，避免每个请求都刷一行。 */
  readonly verbose?: boolean;
}

export function createLogger(options: ConsoleLoggerOptions = {}): LlmLogger {
  const write =
    options.write ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const secrets = options.secrets ?? [];
  const verbose = options.verbose ?? false;

  return (level, message, detail) => {
    if (!verbose && level === "info") return;
    const tail = detail === undefined ? "" : ` | ${redactSecrets(truncate(detail, 600), secrets)}`;
    write(`[llm][${level}] ${redactSecrets(message, secrets)}${tail}`);
  };
}
