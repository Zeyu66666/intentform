import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FormBlueprint } from "@intentform/schema";

import { BlueprintCard } from "./BlueprintCard";

/**
 * 回归：知识点行只给教师看中文名字，不暴露内部 id（`kp_op` 这种）。
 *
 * 内部 id 仍然留在蓝图里（题目引用它），但不该出现在教师可编辑的输入框里；
 * 改名字时 `blueprint-edit.ts` 负责保持 id 不变。
 */
describe("BlueprintCard 的知识点标签", () => {
  it("渲染中文名称，不把内部 id 当输入内容", () => {
    const blueprint = {
      title: "二次函数入门",
      kind: "quiz",
      sections: [{ title: "基础", count: 2 }],
      totalCount: 2,
      typeMix: { single: 2 },
      totalScore: 10,
      knowledgePoints: [{ id: "kp_op", name: "开口方向" }],
    } as const satisfies FormBlueprint;

    const markup = renderToStaticMarkup(
      createElement(BlueprintCard, {
        blueprint,
        onConfirm: () => undefined,
        onSkip: () => undefined,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain("开口方向");
    expect(markup).not.toContain("kp_op");
  });

  it("配额行显示知识点中文名与题型，内部 id 只作为 option value", () => {
    const blueprint = {
      title: "立体几何测验",
      kind: "quiz",
      sections: [{ title: "全部", count: 2 }],
      totalCount: 2,
      typeMix: { single: 1, short: 1 },
      totalScore: 10,
      knowledgePoints: [{ id: "kp_solid", name: "立体几何" }],
      quotas: [{ knowledgePoint: "kp_solid", type: "short", count: 1 }],
    } as const satisfies FormBlueprint;

    const markup = renderToStaticMarkup(
      createElement(BlueprintCard, {
        blueprint,
        onConfirm: () => undefined,
        onSkip: () => undefined,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain("按知识点指定题目");
    expect(markup).toContain("plan-quota");
    expect(markup).toContain("立体几何");
    expect(markup).toContain("简答");
    expect(markup).not.toContain(">kp_solid<");
    expect(markup).not.toContain('value="scale"');
  });
});
