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
 *
 * 形状对齐《计划 v1.1》附录 A.1：判别字段 `type`、顶层容器 `items`。
 * 这里只做重导出，不放实现；调用方一律 `import { ... } from "@intentform/schema"`。
 */

export * from "./constants";
export * from "./types";
export * from "./errors";
export * from "./rules";
