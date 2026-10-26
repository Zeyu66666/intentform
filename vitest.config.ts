import { defineConfig } from "vitest/config";

/**
 * 测试布局：测试文件与被测模块同目录（`*.test.ts`），不设独立 tests/ 目录。
 * 理由是单测直接引用同目录的类型，重构时一起移动，不会留下悬挂的测试路径。
 * 覆盖率阈值先不设死（I1 起按计划要求 schema ≥90%、server ≥70% 用 CI 报告卡）。
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "server/src/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    reporters: ["default"],
    // 生成链路依赖确定性：测试里禁止并发跑同一 fixture 目录
    pool: "threads",
    isolate: true,
  },
});
