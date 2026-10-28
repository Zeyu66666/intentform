/**
 * @intentform/schema — 前后端共享的类型契约层（barrel）。
 *
 * 分层：
 * - `constants.ts` —— 版本号、枚举、上限、守卫（无运行时依赖）
 * - `types.ts`     —— Zod 定义与从 infer 导出的类型（I1）
 * - `errors.ts`    —— 错误码与回喂模型的修复提示（I1）
 * - `rules.ts`     —— 语义规则 R1–R8（I1）
 * - `latex.ts`     —— KaTeX 解析校验（R7，I1）
 * - `public-view.ts` —— 学生端投影 `publicView()`（I1）
 * - `sse-events.ts` —— 生成链路 SSE 事件契约（I2，前后端唯一契约源）
 *
 * 形状对齐《计划 v1.1》附录 A.1：判别字段 `type`、顶层容器 `items`。
 * 除下面的装配外只做重导出，不放实现。
 */

import { checkLatex } from "./latex.ts";
import {
  validateForm as validateFormWithRules,
  type ValidateOptions,
  type ValidationResult,
} from "./rules.ts";

export * from "./constants.ts";
export * from "./types.ts";
export * from "./errors.ts";
export * from "./rules.ts";
export * from "./latex.ts";
export * from "./public-view.ts";
export * from "./sse-events.ts";
export * from "./presets.ts";
export * from "./clarify.ts";
export * from "./blueprint.ts";
export * from "./api.ts";
export * from "./patch.ts";

/**
 * 生产装配：R7 使用真实的 KaTeX 校验。
 *
 * `rules.ts` 刻意不依赖 KaTeX（单测要能注入假 checker），默认实现在这里接上。
 * 这样任何 `import { validateForm } from "@intentform/schema"` 的调用方都不会
 * 因为忘记传 `checkLatex` 而静默跳过 R7——`rules.validateForm` 是内部的、可注入的那个。
 */
export function validateForm(input: unknown, options: ValidateOptions = {}): ValidationResult {
  return validateFormWithRules(input, { ...options, checkLatex });
}
