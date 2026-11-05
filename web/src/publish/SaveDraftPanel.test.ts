import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CreateFormResponse } from "@intentform/schema";

import type { TeacherApi } from "../api/teacher";
import { SaveDraftPanel } from "./SaveDraftPanel";

/** 保存面板在 SSR 下不调接口；桩只为满足类型，真调用会立刻炸出来。 */
const API: Pick<TeacherApi, "createForm"> = {
  createForm: async () => {
    throw new Error("保存面板的静态渲染不应发请求");
  },
};

const CREATED: CreateFormResponse = {
  ok: true,
  form: {
    id: "form-1",
    title: "高三数学卷",
    kind: "quiz",
    status: "draft",
    draftVersionId: "version-1",
    updatedAt: "2026-11-05T08:00:00.000Z",
  },
  version: {
    id: "version-1",
    n: 1,
    source: "generate",
    promptVersion: "gen_1",
    createdAt: "2026-11-05T08:00:00.000Z",
  },
};

describe("SaveDraftPanel", () => {
  it("未保存时只有「保存为草稿」，不再出现「保存并发布」", () => {
    const markup = renderToStaticMarkup(
      createElement(SaveDraftPanel, {
        fields: [],
        requirementText: "出一份高三数学卷",
        kind: "quiz",
        api: API,
        saved: null,
        onSaved: () => undefined,
      }),
    );
    expect(markup).toContain("保存为草稿");
    expect(markup).not.toContain("保存并发布");
    expect(markup).toContain('data-testid="save-draft"');
  });

  it("保存后给出草稿版本与编辑器入口，不在这里发布", () => {
    const markup = renderToStaticMarkup(
      createElement(SaveDraftPanel, {
        fields: [],
        requirementText: "出一份高三数学卷",
        kind: "quiz",
        api: API,
        saved: CREATED,
        onSaved: () => undefined,
      }),
    );
    expect(markup).toContain("草稿 v1 已保存");
    expect(markup).toContain("/forms/form-1/edit");
    expect(markup).toContain("去编辑并发布");
    expect(markup).not.toContain("/publish");
  });
});
