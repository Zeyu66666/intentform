import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PLAN_REFERENCE_MAX_CHARS } from "@intentform/schema";

import { RequirementPanel, type RequirementPanelProps } from "./RequirementPanel";

function render(overrides: Partial<RequirementPanelProps> = {}): string {
  const props: RequirementPanelProps = {
    requirement: "出 5 道单选题",
    status: "idle",
    kind: "quiz",
    onKindChange: () => undefined,
    onRequirementChange: () => undefined,
    onStart: () => undefined,
    onCancel: () => undefined,
    onReset: () => undefined,
    demoNotice: null,
    planFirst: true,
    onPlanFirstChange: () => undefined,
    reference: "",
    onReferenceChange: () => undefined,
    webSearch: false,
    onWebSearchChange: () => undefined,
    webSearchDisabled: true,
    webSearchHint: "当前为离线演示模式，联网参考不会生效。",
    ...overrides,
  };
  return renderToStaticMarkup(createElement(RequirementPanel, props));
}

function inputTag(markup: string, testId: string): string {
  const index = markup.indexOf(`data-testid="${testId}"`);
  const start = markup.lastIndexOf("<input", index);
  const end = markup.indexOf(">", index);
  return markup.slice(start, end);
}

describe("RequirementPanel 的参考卷与联网开关", () => {
  it("离线模式禁用联网勾选框，并显示原因", () => {
    const markup = render();
    expect(inputTag(markup, "web-search")).toContain("disabled");
    expect(markup).toContain("当前为离线演示模式，联网参考不会生效。");
  });

  it("live 模式可勾选；参考卷是折叠 textarea，标出 20000 字上限", () => {
    const markup = render({
      webSearchDisabled: false,
      webSearchHint: "仅在当前 live 模式生效；服务端还要配置搜索端点与 Key。",
    });
    expect(inputTag(markup, "web-search")).not.toContain("disabled");
    expect(markup).toContain("参考试卷（可选）");
    expect(markup).toContain(`最多 ${String(PLAN_REFERENCE_MAX_CHARS)} 字`);
    expect(markup).toContain("不会复制原题");
  });
});
