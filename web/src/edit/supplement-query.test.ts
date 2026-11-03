import { describe, expect, it } from "vitest";

import { parseAddQuery } from "./supplement-query";

describe("parseAddQuery", () => {
  it("合法的 add=1 + kp + bloom 才返回预填", () => {
    expect(parseAddQuery("?add=1&kp=kp_vertex&bloom=apply")).toEqual({
      knowledgePoint: "kp_vertex",
      bloom: "apply",
    });
  });

  it("缺 add 标记或任一参数就退回普通编辑", () => {
    expect(parseAddQuery("?kp=kp_vertex&bloom=apply")).toBeNull();
    expect(parseAddQuery("?add=1&bloom=apply")).toBeNull();
    expect(parseAddQuery("?add=1&kp=kp_vertex")).toBeNull();
  });

  it("非法层级或知识点 id 不部分应用", () => {
    expect(parseAddQuery("?add=1&kp=kp_vertex&bloom=unknown")).toBeNull();
    expect(parseAddQuery("?add=1&kp=KP&bloom=apply")).toBeNull();
    expect(parseAddQuery("?add=1&kp=&bloom=apply")).toBeNull();
  });
});
