/**
 * 演示数据（《计划 v2.0》I4 产出：演示教师 + 2 份表单 + 30 条提交）。
 *
 * 幂等的做法是**重建**：先删掉数据库文件再建。原因很实际——
 * `form_versions` 被触发器锁成追加式（`BEFORE DELETE ... RAISE(ABORT)`），
 * 用 `DELETE FROM` 清数据会被自己的约束挡住；而「删库重来」对演示数据是正确的语义：
 * 这个文件里没有用户数据，只有我们编的东西。
 *
 * 所有内容都是虚构的：教师邮箱用 `example.com` 保留域，学生 IP 用
 * `192.0.2.0/24`（TEST-NET-1，RFC 5737 专供文档示例），没有真实人名。
 * 提交的分数不是手写的，而是**跑一遍真实判分函数**算出来的——这样种子数据
 * 和线上判分口径不可能漂移。
 */

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { hashSync } from "@node-rs/argon2";
import { formSchema } from "@intentform/schema";
import { insertFormWithInitialVersion, publishVersion } from "./db/forms.ts";
import { openDatabase, type Db } from "./db/index.ts";
import { insertSubmission, upsertManualGrade } from "./db/submissions.ts";
import { insertTeacher } from "./db/teachers.ts";
import { readServerEnv } from "./env.ts";
import { gradeSubmission, type AnswerValue } from "./grading.ts";
import { newId, newSlug } from "./ids.ts";

export const DEMO_TEACHER_EMAIL = "teacher@example.com";
/** 演示密码是公开的、固定的；写在脚本里而不是环境变量里，是为了「跑一遍就能登」。 */
export const DEMO_TEACHER_PASSWORD = "intentform-demo";

/** 24 条测验提交 + 6 条问卷提交 = 30 条。 */
const QUIZ_SUBMISSION_PATTERNS: readonly (readonly string[])[] = [
  [], [], [], [], [], [], [], [], // 全对
  ["q3-roots"], ["q3-roots"], ["q3-roots"], ["q3-roots"], ["q3-roots"], // 多选错
  ["q5-sum"], ["q5-sum"], ["q5-sum"], ["q5-sum"], // 数字题未答
  ["q1-vertex"], ["q1-vertex"], ["q1-vertex"], // 顶点坐标错
  ["q2-axis", "q3-roots"], ["q2-axis", "q3-roots"], // 两题错
  ["q1-vertex", "q2-axis", "q3-roots"], // 只对一半
  ["q1-vertex", "q2-axis", "q3-roots", "q4-min", "q5-sum"], // 0 分
];

const SURVEY_FEEDBACK: readonly { readonly gain: string; readonly load: string; readonly suggest: string }[] = [
  { gain: "顶点式配方法终于搞懂了", load: "4", suggest: "希望多讲一点判别式的几何意义" },
  { gain: "做题速度变快了", load: "3", suggest: "可以多一些口算练习" },
  { gain: "知道怎么从图像读出对称轴", load: "4", suggest: "随堂测能不能缩短一点" },
  { gain: "错题本整理有用了", load: "5", suggest: "作业量最近偏多" },
  { gain: "和同学互相讲题很有帮助", load: "3", suggest: "想要更多变式训练" },
  { gain: "还不确定，需要再练", load: "2", suggest: "希望能再讲一遍配方法" },
];

function demoQuizSchema(): unknown {
  return {
    meta: {
      version: 1,
      kind: "quiz",
      title: "初二数学 · 二次函数随堂测",
      objectives: [
        { id: "kp-vertex", name: "顶点式与对称轴" },
        { id: "kp-root", name: "根与判别式" },
      ],
      totalScore: 30,
    },
    items: [
      {
        id: "q1-vertex",
        type: "single",
        title: "已知 $y=(x-2)^2+3$，它的顶点坐标是？",
        required: true,
        score: 5,
        bloom: "understand",
        knowledgePoint: "kp-vertex",
        explanation: "顶点式 $y=a(x-h)^2+k$ 的顶点是 $(h,k)$，这里 $h=2$、$k=3$。",
        options: [
          { id: "op1", text: "$(2,\\,3)$" },
          { id: "op2", text: "$(-2,\\,3)$" },
          { id: "op3", text: "$(2,\\,-3)$" },
          { id: "op4", text: "$(3,\\,2)$" },
        ],
        answer: "op1",
      },
      {
        id: "q2-axis",
        type: "single",
        title: "抛物线 $y=x^2-4x+1$ 的对称轴是？",
        required: true,
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-vertex",
        explanation: "对称轴 $x=-\\frac{b}{2a}=\\frac{4}{2}=2$。",
        options: [
          { id: "op1", text: "$x=-2$" },
          { id: "op2", text: "$x=2$" },
          { id: "op3", text: "$x=4$" },
          { id: "op4", text: "$x=1$" },
        ],
        answer: "op2",
      },
      {
        id: "q3-roots",
        type: "multi",
        title: "下列方程中，判别式大于 0 的有哪些？",
        required: true,
        score: 5,
        bloom: "analyze",
        knowledgePoint: "kp-root",
        explanation: "判别式 $\\Delta=b^2-4ac>0$ 时有两个不相等的实根。",
        options: [
          { id: "op1", text: "$x^2-2x-3=0$" },
          { id: "op2", text: "$x^2-2x+1=0$" },
          { id: "op3", text: "$2x^2+x-1=0$" },
          { id: "op4", text: "$x^2+x+2=0$" },
        ],
        answer: ["op1", "op3"],
      },
      {
        id: "q4-min",
        type: "fill",
        title: "函数 $y=(x+1)^2-4$ 的最小值是？（填一个数）",
        required: true,
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-vertex",
        explanation: "开口向上，顶点处取最小值 $-4$。",
        // 两个变体是刻意的：学生可能打 ASCII 连字符也可能打 Unicode 减号。
        answer: ["-4", "−4"],
      },
      {
        id: "q5-sum",
        type: "number",
        title: "方程 $x^2-6x+5=0$ 的两根之和是多少？（误差 0）",
        required: true,
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-root",
        explanation: "韦达定理：$x_1+x_2=-\\frac{b}{a}=6$。",
        answer: { value: 6, tolerance: 0 },
      },
      {
        id: "q6-explain",
        type: "short",
        title: "说说你是怎么求顶点坐标的（写思路即可）",
        required: false,
        score: 5,
        bloom: "understand",
        knowledgePoint: "kp-vertex",
        maxLength: 300,
      },
    ],
  };
}

function demoSurveySchema(): unknown {
  return {
    meta: {
      version: 1,
      kind: "survey",
      title: "课程反馈 · 第 3 周",
      objectives: [],
    },
    items: [
      {
        id: "sec-basic",
        type: "section",
        title: "本周课程反馈",
        description: "匿名收集，只用于改进下周的课堂节奏。",
      },
      {
        id: "s1-gain",
        type: "short",
        title: "本周最有收获的一点是什么？",
        required: true,
        maxLength: 200,
      },
      {
        id: "s2-load",
        type: "scale",
        title: "本周作业量是否合适？",
        required: true,
        min: 1,
        max: 5,
        labels: ["太少", "太多"],
      },
      {
        id: "s3-suggest",
        type: "short",
        title: "希望老师改进的地方（可不填）",
        required: false,
        maxLength: 300,
      },
    ],
  };
}

export interface SeedResult {
  readonly teacherId: string;
  readonly forms: readonly { readonly id: string; readonly slug: string; readonly title: string; readonly kind: string }[];
  readonly submissions: number;
}

export interface SeedOptions {
  readonly argon2MemoryKib: number;
  readonly now?: Date;
}

function demoIpHash(index: number): string {
  // 192.0.2.0/24 是 RFC 5737 的文档示例网段，不可能对应真实学生。
  return createHash("sha256")
    .update(`intentform-demo-seed:192.0.2.${String(index % 250)}`)
    .digest("hex");
}

export function seedDemoData(db: Db, options: SeedOptions): SeedResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const teacherId = newId("t");
  insertTeacher(db, {
    id: teacherId,
    email: DEMO_TEACHER_EMAIL,
    password_hash: hashSync(DEMO_TEACHER_PASSWORD, { memoryCost: options.argon2MemoryKib }),
    created_at: nowIso,
  });

  const quiz = formSchema.parse(demoQuizSchema());
  const survey = formSchema.parse(demoSurveySchema());

  const forms: { id: string; slug: string; title: string; kind: string }[] = [];

  const createPublished = (schema: typeof quiz, title: string, kind: "quiz" | "survey"): string => {
    const formId = newId("f");
    const versionId = newId("v");
    const slug = newSlug();
    insertFormWithInitialVersion(
      db,
      { id: formId, teacherId, title, kind, updatedAt: nowIso },
      {
        id: versionId,
        formId,
        schemaJson: JSON.stringify(schema),
        source: "generate",
        parentId: null,
        promptVersion: "demo-seed",
        createdAt: nowIso,
      },
    );
    publishVersion(db, { teacherId, formId, versionId, slug, updatedAt: nowIso });
    forms.push({ id: formId, slug, title, kind });
    return versionId;
  };

  const quizVersionId = createPublished(quiz, "初二数学 · 二次函数随堂测", "quiz");
  const surveyVersionId = createPublished(survey, "课程反馈 · 第 3 周", "survey");

  const quizFormId = forms[0]?.id ?? "";
  const surveyFormId = forms[1]?.id ?? "";

  const baseAnswers: Record<string, AnswerValue> = {
    "q1-vertex": "op1",
    "q2-axis": "op2",
    "q3-roots": ["op3", "op1"], // 顺序刻意的：判分不看顺序
    "q4-min": "−4", // Unicode 减号变体
    "q5-sum": "6",
    "q6-explain": "配方：$y=(x-2)^2+3$，所以顶点是 $(2,3)$，对称轴 $x=2$。",
  };

  /**
   * 前 4 条在种子里就批好（4/5 分），其余留作待批改。
   *
   * 理由：看板上要能同时看到「已批完」和「待批改」两种状态，
   * 否则演示时每条都要点一次「批改」，观众看不出这两种状态的区别。
   */
  const DEMO_MANUAL_SCORES: readonly number[] = [4, 5, 3, 4];

  const startMs = now.getTime() - 9 * 24 * 60 * 60 * 1000;
  let inserted = 0;

  QUIZ_SUBMISSION_PATTERNS.forEach((dropped, index) => {
    const answers: Record<string, AnswerValue> = {};
    for (const [fieldId, value] of Object.entries(baseAnswers)) {
      if (dropped.includes(fieldId)) continue;
      answers[fieldId] = value;
    }
    const grade = gradeSubmission(quiz, answers);
    if (!grade.ok) {
      throw new Error(`种子数据被判分拒收（不应发生）：${grade.message}`);
    }
    const submissionId = newId("s");
    const manualGiven = DEMO_MANUAL_SCORES[index];
    // 人工分在种子里直接写进 score：`score` 的口径是"已确定的分"（自动 + 人工），
    // 播种后再改一次会让演示数据出现两套算法，不如一开始就算清。
    const finalScore = manualGiven === undefined ? grade.score : grade.score + manualGiven;
    insertSubmission(db, {
      id: submissionId,
      formId: quizFormId,
      formVersionId: quizVersionId,
      answersJson: JSON.stringify(answers),
      score: finalScore,
      maxScore: grade.maxScore,
      ipHash: demoIpHash(index),
      // 铺开在 9 天里，每小时一条，看板的 created_at 才有分布。
      createdAt: new Date(startMs + index * 8 * 60 * 60 * 1000).toISOString(),
    });
    if (manualGiven !== undefined) {
      upsertManualGrade(db, {
        submissionId,
        itemId: "q6-explain",
        score: manualGiven,
        teacherId,
        gradedAt: new Date(startMs + index * 8 * 60 * 60 * 1000 + 60_000).toISOString(),
      });
    }
    inserted += 1;
  });

  SURVEY_FEEDBACK.forEach((feedback, index) => {
    const answers: Record<string, AnswerValue> = {
      "s1-gain": feedback.gain,
      "s2-load": feedback.load,
      "s3-suggest": feedback.suggest,
    };
    const grade = gradeSubmission(survey, answers);
    if (!grade.ok) {
      throw new Error(`种子数据被判分拒收（不应发生）：${grade.message}`);
    }
    insertSubmission(db, {
      id: newId("s"),
      formId: surveyFormId,
      formVersionId: surveyVersionId,
      answersJson: JSON.stringify(answers),
      score: grade.score,
      maxScore: grade.maxScore,
      ipHash: demoIpHash(100 + index),
      createdAt: new Date(startMs + (index + 1) * 26 * 60 * 60 * 1000).toISOString(),
    });
    inserted += 1;
  });

  return { teacherId, forms, submissions: inserted };
}

/** 删库重建：唯一可靠的「重跑一次结果一致」的做法（见文件头注释）。 */
export function resetDatabaseFile(databasePath: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const target = `${databasePath}${suffix}`;
    if (existsSync(target)) rmSync(target);
  }
}

function main(): void {
  const env = readServerEnv(process.env);
  if (env.databasePath === ":memory:") {
    process.stderr.write("[seed] DATABASE_PATH 是 :memory:，种子数据写完就随进程消失了\n");
    process.exitCode = 1;
    return;
  }
  resetDatabaseFile(env.databasePath);
  const db = openDatabase(env.databasePath);
  try {
    const result = seedDemoData(db, { argon2MemoryKib: env.argon2MemoryKib });
    process.stdout.write(`[seed] 数据库已重建：${env.databasePath}\n`);
    process.stdout.write(
      `[seed] 演示教师：${DEMO_TEACHER_EMAIL} / ${DEMO_TEACHER_PASSWORD}\n`,
    );
    for (const form of result.forms) {
      process.stdout.write(`[seed] 表单 ${form.id}（${form.kind}）${form.title} → /f/${form.slug}\n`);
    }
    process.stdout.write(`[seed] 提交：${String(result.submissions)} 条\n`);
  } finally {
    db.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main();
}
