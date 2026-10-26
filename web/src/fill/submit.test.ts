import { describe, expect, it } from "vitest";

import { VERSION_CONFLICT_MESSAGE } from "@intentform/schema";

import { EMPTY_ANSWERS, type AnswerState } from "./answers";
import {
  BLANK_INPUT_PLACEHOLDER,
  BLANK_SEPARATOR,
  beginSubmit,
  buildSubmitRequest,
  canSubmit,
  formatSuccess,
  mapSubmitOutcome,
  splitBlanks,
  toWireAnswers,
} from "./submit";
import { quizView, surveyView } from "./__fixtures__/public-form";

describe("splitBlanks", () => {
  it("按全角「／」切，一个元素 = 一个空", () => {
    expect(splitBlanks(`8${BLANK_SEPARATOR}12`)).toEqual(["8", "12"]);
    expect(splitBlanks(` 8 ${BLANK_SEPARATOR} 12 `)).toEqual(["8", "12"]);
    expect(splitBlanks("只有一个空")).toEqual(["只有一个空"]);
  });

  it("半角 `/` 不切：数学答案 1/2 不能被切成两个空", () => {
    expect(splitBlanks("1/2")).toEqual(["1/2"]);
  });

  it("输入框提示同时说到全角「／」与半角 `/` 两种分隔符", () => {
    // 判分侧两种都收（I4 联调对齐），提示只写一种会让敲另一种的学生以为写坏了。
    expect(BLANK_INPUT_PLACEHOLDER).toContain(BLANK_SEPARATOR);
    expect(BLANK_INPUT_PLACEHOLDER).toContain("/");
    expect(BLANK_INPUT_PLACEHOLDER).not.toBe(BLANK_SEPARATOR);
  });
});

describe("toWireAnswers", () => {
  it("填空题交数组（按空），其余交字符串；空答案与 section 不进请求体", () => {
    const answers: AnswerState = {
      "item-single": "b",
      "item-fill": `8${BLANK_SEPARATOR}12`,
      "item-multi": ["a", "c"],
    };
    const wire = toWireAnswers(quizView().form.items, answers);

    expect(wire["item-fill"]).toEqual(["8", "12"]);
    expect(wire["item-single"]).toBe("b");
    expect(wire["item-multi"]).toEqual(["a", "c"]);
    // 未作答的题不出现；section 永远不出现。
    expect(Object.hasOwn(wire, "item-number")).toBe(false);
    expect(Object.hasOwn(wire, "sec-intro")).toBe(false);
  });

  it("全是空白输入的字段等同于没答，不提交", () => {
    const wire = toWireAnswers(quizView().form.items, { "item-short": "   " });
    expect(wire).toEqual({});
  });
});

describe("buildSubmitRequest", () => {
  it("formVersionId 取本次渲染的 versionId（§3.5 旧版拒绝策略的前提）", () => {
    const view = quizView();
    const request = buildSubmitRequest(view, { "item-single": "b" });
    expect(request.slug).toBe("abc123");
    expect(request.formVersionId).toBe(view.versionId);
    expect(request.formVersionId).toBe("ver-2");
    expect(request.answers).toEqual({ "item-single": "b" });
  });

  it("形状与 SubmitRequest 一致：只有 slug / formVersionId / answers 三个键", () => {
    const request = buildSubmitRequest(quizView(), EMPTY_ANSWERS);
    expect(Object.keys(request).sort()).toEqual(["answers", "formVersionId", "slug"]);
  });
});

describe("beginSubmit", () => {
  it("有必答项没填：进 blocked 并带清单，而不是直接提交", () => {
    const state = beginSubmit(quizView().form.items, EMPTY_ANSWERS);
    expect(state.kind).toBe("blocked");
    if (state.kind !== "blocked") return;
    expect(state.missing.map((entry) => entry.fieldId)).toEqual(["item-single", "item-fill"]);
    // blocked 是提示态：补完能再点，所以按钮不禁用。
    expect(canSubmit(state)).toBe(true);
  });

  it("必答项补齐：进 submitting", () => {
    const state = beginSubmit(quizView().form.items, {
      "item-single": "b",
      "item-fill": "12",
    });
    expect(state).toEqual({ kind: "submitting" });
    expect(canSubmit(state)).toBe(false);
  });
});

describe("mapSubmitOutcome", () => {
  it("quiz 成功只给「得分 / 满分」", () => {
    const state = mapSubmitOutcome(
      { ok: true, data: { ok: true, submissionId: "s1", score: 8, maxScore: 10 } },
      "quiz",
    );
    expect(state.kind).toBe("success");
    if (state.kind !== "success") return;
    expect(state.success.summary).toBe("8 / 10 分");
    expect(canSubmit(state)).toBe(false);
  });

  it("survey 成功只说「已提交」，不显示分数", () => {
    const state = mapSubmitOutcome(
      { ok: true, data: { ok: true, submissionId: "s2", score: 0, maxScore: 0 } },
      "survey",
    );
    if (state.kind !== "success") throw new Error("应为 success");
    expect(state.success.summary).toBe("已提交");
  });

  it("409 走专属 conflict 态：给契约文案、禁提交（重试没用，得刷新页面）", () => {
    const state = mapSubmitOutcome(
      {
        ok: false,
        failure: { status: 409, code: "version_conflict", message: "conflict" },
      },
      "quiz",
    );
    expect(state.kind).toBe("conflict");
    if (state.kind !== "conflict") return;
    expect(state.message).toBe(VERSION_CONFLICT_MESSAGE);
    expect(canSubmit(state)).toBe(false);
  });

  it("service 用错误码表达冲突时也认（不只认状态码）", () => {
    const state = mapSubmitOutcome(
      { ok: false, failure: { status: 400, code: "version_conflict", message: "x" } },
      "quiz",
    );
    expect(state.kind).toBe("conflict");
  });

  it("断网 → failed，可重试", () => {
    const state = mapSubmitOutcome(
      { ok: false, failure: { status: null, code: null, message: "网络异常，请检查连接后重试" } },
      "quiz",
    );
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.message).toBe("网络异常，请检查连接后重试");
    expect(canSubmit(state)).toBe(true);
  });

  it("表单已下架（404）→ failed，文案说清后果", () => {
    const state = mapSubmitOutcome(
      { ok: false, failure: { status: 404, code: "not_found", message: "not found" } },
      "quiz",
    );
    if (state.kind !== "failed") throw new Error("应为 failed");
    expect(state.message).toContain("已失效");
  });

  it("失败态不回显任何答案内容（状态里根本没有这个字段）", () => {
    const state = mapSubmitOutcome(
      { ok: false, failure: { status: 400, code: "bad_request", message: "缺少必答项 item-single" } },
      "quiz",
    );
    expect(Object.keys(state).sort()).toEqual(["kind", "message"]);
  });
});

describe("formatSuccess", () => {
  it("quiz 带分数、survey 只说已提交", () => {
    expect(formatSuccess("quiz", 7, 20)).toBe("7 / 20 分");
    expect(formatSuccess("survey", 0, 0)).toBe("已提交");
  });

  it("与真实视图的 kind 对得上（夹具里两份分别是 quiz / survey）", () => {
    expect(quizView().form.meta.kind).toBe("quiz");
    expect(surveyView().form.meta.kind).toBe("survey");
  });
});
