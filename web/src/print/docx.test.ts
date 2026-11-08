import { describe, expect, it } from "vitest";

import { formSchema, type FormSchema } from "@intentform/schema";

import { buildDocx, docxFilename, imageSize, latexToOmml } from "./docx";
import { buildPrintSheet } from "./sheet";

function quiz(): FormSchema {
  return formSchema.parse({
    meta: {
      version: 1,
      kind: "quiz",
      title: "二次函数 <随堂测>",
      objectives: [],
      totalScore: 10,
    },
    items: [
      { id: "sec-one", type: "section", title: "一、选择题", description: "每题 5 分" },
      {
        id: "q-single",
        type: "single",
        title: "求 $\\sqrt{81}$ 与 $\\frac{1}{2}$ 的值。\n（1）先化简；\n（2）再比较。",
        required: true,
        score: 5,
        options: [
          { id: "op1", text: "$x=1$" },
          { id: "op2", text: "$x=2$" },
        ],
        answer: "op2",
        explanation: "因为 $x^2=4$。",
      },
      {
        id: "q-fill",
        type: "fill",
        title: "填 $a_{n+1}=2a_n+3$ 的下一项。",
        required: true,
        score: 5,
        answer: ["9"],
      },
    ],
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("latexToOmml", () => {
  it("分式、根号、上下标转成 Word 原生公式结构", () => {
    expect(latexToOmml("\\frac{1}{2}")).toContain("<m:f>");
    expect(latexToOmml("\\sqrt{81}")).toContain("<m:rad>");
    expect(latexToOmml("x^2")).toContain("<m:sSup>");
    expect(latexToOmml("a_{n+1}")).toContain("<m:sSub>");
  });

  it("公式里的填空横线也进 OMML，而不是退回 ___ 源码", () => {
    const omml = latexToOmml("12-___=7");
    expect(omml).toContain("<m:");
    expect(omml).not.toContain("___");
  });

  it("KaTeX 不认的公式退回原始 TeX，不抛错也不丢题面", () => {
    const omml = latexToOmml("\\notARealCommand{");
    expect(omml).toContain("m:t");
    expect(omml).toContain("notARealCommand");
  });
});

describe("buildDocx", () => {
  it("产出 ZIP 容器与五份 OOXML 部件", () => {
    const bytes = buildDocx(quiz(), buildPrintSheet(quiz(), { withAnswers: true }));
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const raw = text(bytes);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
    ]) {
      expect(raw).toContain(part);
    }
  });

  it("题面换行落成 <w:br/>，标题里的尖括号被转义", () => {
    const raw = text(buildDocx(quiz(), buildPrintSheet(quiz(), { withAnswers: false })));
    expect(raw).toContain("<w:br/>");
    expect(raw).toContain("&lt;随堂测&gt;");
    expect(raw).not.toContain("<随堂测>");
  });

  it("公式进 OMML，且不再保留 $ 分隔符", () => {
    const raw = text(buildDocx(quiz(), buildPrintSheet(quiz(), { withAnswers: false })));
    expect(raw).toContain("<m:oMath>");
    expect(raw).toContain("<m:f>");
    expect(raw).not.toContain("$\\sqrt{81}$");
  });

  it("有配图时写入 word/media 与 drawing；PNG 尺寸从文件头读出", () => {
    const png = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    expect(imageSize(png, "image/png")).toEqual({ width: 1, height: 1 });
    const withImage = formSchema.parse({
      ...quiz(),
      items: quiz().items.map((item) =>
        item.id === "q-fill"
          ? { ...item, image: { assetId: "a_0123456789abcdef", alt: "实验装置" } }
          : item,
      ),
    });
    const raw = text(
      buildDocx(
        withImage,
        buildPrintSheet(withImage, { withAnswers: false }),
        new Map([
          [
            "a_0123456789abcdef",
            { bytes: png, mime: "image/png" as const, width: 1, height: 1 },
          ],
        ]),
      ),
    );
    expect(raw).toContain("word/media/image0.png");
    expect(raw).toContain("<w:drawing>");
    expect(/r:embed="([^"]+)"/u.exec(raw)?.[1]).toBe("rId2");
  });

  it("默认不含答案；含答案时出现答案与解析", () => {
    const plain = text(buildDocx(quiz(), buildPrintSheet(quiz(), { withAnswers: false })));
    expect(plain).not.toContain("答案：");
    expect(plain).not.toContain("解析：");

    const withAnswers = text(buildDocx(quiz(), buildPrintSheet(quiz(), { withAnswers: true })));
    expect(withAnswers).toContain("答案：");
    expect(withAnswers).toContain("解析：");
  });
});

describe("docxFilename", () => {
  it("去掉 Windows 非法字符，空标题兜底", () => {
    expect(docxFilename('a/b:c*?"<>|')).toBe("abc.docx");
    expect(docxFilename("   ")).toBe("试卷.docx");
  });
});
