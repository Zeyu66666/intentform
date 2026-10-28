/**
 * 达标判定（纯函数）：需求里写死的约束 ↔ 成品结构。
 *
 * 为什么单独拆出来：`pnpm eval` 要回答的是「这一版 Prompt 有没有把需求满足掉」，
 * 而「满足」必须能用同一把尺子重复量。尺子一旦掺进网络、时间、模式判断，两次跑出来
 * 的百分比就没法比。所以这里只有数据进、判定出，不读文件、不起服务、不看模式。
 *
 * 判定分三层（对应《计划 v3.0》§2.4 四层意图控制里能自动量的那三层）：
 *   blueprint  题量 / 题型 / 分值 / 知识点 —— 需求的显式约束有没有落进成品结构
 *   validation 语义规则 —— 问卷不许带答案与分值（R3/R5）
 *   policy     生成是否真的走完门禁 —— 由调用方把 gateBlocked 传进来，不在这里猜
 *
 * 两个刻意的口径（都在 eval/README.md 里写了理由）：
 *   1. 事件流只下发字段，不下发 `meta`（I2 契约如此）。所以「分值」以逐题合计为准，
 *      「知识点」以题干文本里是否出现该知识点为证据，不假装看过 `meta.objectives`。
 *   2. 澄清层（缺槽位追问）没有可自动判的东西：产品当前不追问，记 0 并单列。
 *   3. 问卷只按产品自己的 R3/R5 判（`rules.ts:214-232`：禁 `answer` 与 `score`）。
 *      `bloom` / `knowledgePoint` 是 schema 允许的字段，判据不得比产品更严——
 *      v2 曾经把它们也算违规，实测误伤 3 条问卷，v3 已改。
 */

/** 判定器版本。改了判定口径必须改它，否则新旧报告会被当成同一把尺子。 */
export const JUDGE_VERSION = "fitness.v3";

/** 参与「题量」计数的类型。`section` 是结构节点，不算题。 */
export const FIELD_TYPES = ["single", "multi", "fill", "number", "short", "scale"];

/** 去掉分节，只留真题。 */
export function fieldsOf(items) {
  return items.filter((item) => item.type !== "section");
}

/** 按类型计数，六类都出现（没出现记 0），这样两边可以直接比。 */
export function countTypes(items) {
  const counts = {};
  for (const type of FIELD_TYPES) counts[type] = 0;
  for (const field of fieldsOf(items)) {
    counts[field.type] = (counts[field.type] ?? 0) + 1;
  }
  return counts;
}

/** 判分题分值之和。`score` 缺省按 0 算，与判分逻辑一致（缺席就是没分）。 */
export function sumScore(items) {
  return fieldsOf(items).reduce((sum, field) => sum + (typeof field.score === "number" ? field.score : 0), 0);
}

/** 一道题的「可检索文本」：题干 + 知识点标记 + 选项文本。用来查知识点是否真的落在题里。 */
function searchableText(items) {
  return fieldsOf(items)
    .map((field) => {
      const options = Array.isArray(field.options) ? field.options.map((option) => String(option?.text ?? "")).join(" ") : "";
      return `${String(field.title ?? "")} ${String(field.knowledgePoint ?? "")} ${options}`;
    })
    .join(" ");
}

function emptyForm(reason) {
  return {
    passed: false,
    checks: [
      {
        layer: "policy",
        name: "form-present",
        ok: false,
        detail: reason,
      },
    ],
    deviation: null,
  };
}

/**
 * 判定一份成品是否满足需求。
 *
 * @param {{kind?: string | null, items?: unknown[]} | null} form 由 `field` 事件按顺序拼出来的成品
 * @param {object} expect requirements.jsonl 里的 `expect`
 */
export function judgeForm(form, expect) {
  if (form === null || typeof form !== "object" || !Array.isArray(form.items) || form.items.length === 0) {
    return emptyForm("没有可判定的成品：整条生成没有产出任何通过校验的字段");
  }

  const items = form.items;
  const checks = [];
  const push = (layer, name, ok, detail) => {
    checks.push({ layer, name, ok, detail });
  };

  push("blueprint", "form-present", true, `成品有 ${String(items.length)} 个结构节点`);

  // ── blueprint：表单类型（以生成器自己写的判定行为准）──────────────────────
  const actualKind = typeof form.kind === "string" && form.kind !== "" ? form.kind : null;
  const kindOk = actualKind === expect.kind;
  push(
    "blueprint",
    "kind",
    kindOk,
    actualKind === null
      ? "拿不到表单类型判定（事件流里没有该字段）"
      : kindOk
        ? `类型一致：${actualKind}`
        : `需求是 ${expect.kind}，生成器判成 ${actualKind}`,
  );

  // ── blueprint：题量 ─────────────────────────────────────────────────────
  const fields = fieldsOf(items);
  // 简答题没有分值字段（见下方 capability 层注释），判定总分时要先知道这件事
  const unscoredFields = fields.filter((field) => field.type === "short" && typeof field.score !== "number");
  const countDelta = fields.length - expect.count;
  const countOk = countDelta === 0;
  push(
    "blueprint",
    "count",
    countOk,
    countOk
      ? `题量一致：${String(expect.count)} 题`
      : `需求 ${String(expect.count)} 题，成品 ${String(fields.length)} 题（差 ${String(countDelta)}）`,
  );

  // ── blueprint：题型分布 ─────────────────────────────────────────────────
  const actualTypes = countTypes(items);
  const typeDiff = [];
  for (const type of FIELD_TYPES) {
    const want = expect.types?.[type] ?? 0;
    const got = actualTypes[type] ?? 0;
    if (want !== got) typeDiff.push(`${type} 需求 ${String(want)} 实得 ${String(got)}`);
  }
  const typesOk = typeDiff.length === 0;
  const expectedMix = FIELD_TYPES.filter((type) => (expect.types?.[type] ?? 0) > 0)
    .map((type) => `${type}×${String(expect.types[type])}`)
    .join(" ");
  push(
    "blueprint",
    "type-mix",
    typesOk,
    typesOk ? `题型一致：${expectedMix}` : `题型偏差：${typeDiff.join("；")}`,
  );

  // ── blueprint：分值（逐题合计；meta.totalScore 不随流下发，见文件头口径 1）──
  let scoreDelta = null;
  if (typeof expect.totalScore === "number") {
    const summed = sumScore(items);
    scoreDelta = summed - expect.totalScore;
    const scoreOk = scoreDelta === 0;
    push(
      "blueprint",
      "total-score",
      scoreOk,
      scoreOk
        ? `分值一致：逐题合计 ${String(summed)} 分`
        : `需求 ${String(expect.totalScore)} 分，逐题合计 ${String(summed)} 分（差 ${String(scoreDelta)}）${
            unscoredFields.length > 0 ? "，其中简答题无分值字段" : ""
          }`,
    );
  }

  // ── blueprint：知识点覆盖（题干文本为证，见文件头口径 1）───────────────────
  const missingObjectives = [];
  if (Array.isArray(expect.objectives) && expect.objectives.length > 0) {
    const text = searchableText(items);
    for (const keyword of expect.objectives) {
      if (!text.includes(keyword)) missingObjectives.push(keyword);
    }
    const objectivesOk = missingObjectives.length === 0;
    push(
      "blueprint",
      "objectives",
      objectivesOk,
      objectivesOk
        ? `知识点落在题干里：${expect.objectives.join("、")}`
        : `题干里查不到知识点：${missingObjectives.join("、")}`,
    );
  }

  // ── capability：产品结构能不能表达这条需求 ────────────────────────────────
  // 简答题在 schema 层就没有分值字段（`packages/schema/src/types.ts:99`
  // `shortFieldSchema` 继承的是 baseFieldSchema，不是 scoredFieldSchema）。
  // 于是「8 道题、每题 5 分、共 40 分、含 2 道简答」这类需求，模型无论怎么答都凑
  // 不出 40 分——这不是模型没满足需求，是产品缺这个语义。单列一层，不混进模型能力。
  if (typeof expect.totalScore === "number" && unscoredFields.length > 0) {
    push(
      "capability",
      "short-unscored",
      false,
      `${String(unscoredFields.length)} 道简答题没有分值字段（schema 不支持），该需求的总分在当前结构下无法表达`,
    );
  }

  // ── validation：语义规则（问卷不许带答案与分值）────────────────────────────
  if (expect.noAnswers === true) {
    // 只按产品规则判：`packages/schema/src/rules.ts:214-232` 禁的是 answer 与 score。
    // explanation / bloom / knowledgePoint 仍在 schema 里合法（publicView 会剥掉），
    // 判据不能因为「看着多余」就把合格产出判成违规。
    const offenders = fields.filter((field) => field.answer !== undefined || field.score !== undefined);
    const ok = offenders.length === 0;
    push(
      "validation",
      "survey-no-answer",
      ok,
      ok
        ? "问卷未携带答案与分值（规则 R3/R5 成立）"
        : `${String(offenders.length)} 个字段带了答案类信息：${offenders.map((field) => String(field.id)).join("、")}`,
    );
  }

  const passed = checks.every((check) => check.ok);
  return {
    passed,
    checks,
    deviation: { countDelta, typeDiff, scoreDelta, missingObjectives },
  };
}

/** 把一批记录算成报告要的数字。分母固定：传进来几条就是几条，失败不进也不出分母。 */
export function summarize(records) {
  const judged = records.filter((record) => record.judgeable === true);
  const passed = judged.filter((record) => record.passed === true);

  // 蓝图层「结构完全匹配」的资格：必须真的判过蓝图层。空成品（一条字段都没过校验）
  // 只有一条 policy/form-present 判定，没有蓝图层可比——把它算成「匹配」会把
  // 「没产出」洗成「结构对了」，这是这个指标最容易骗人的地方，所以显式排掉。
  const blueprintExact = judged.filter((record) => {
    const blueprintChecks = record.checks.filter((check) => check.layer === "blueprint");
    return blueprintChecks.length > 0 && blueprintChecks.every((check) => check.ok === true);
  });

  // 「没产出任何字段」单列，不让它混进平均偏差（否则分母被 0 偏差撑大，偏差看着变小）
  const noOutput = judged.filter((record) => record.deviation === null || record.deviation === undefined).length;

  // 产品结构表达不了的需求（当前只有「简答计分」这一类）：主指标照样算未达标，
  // 但必须能单独看一份「能表达的需求上，模型做到多少」。两个数一起给，谁也不掩盖谁。
  const capabilityGap = judged.filter((record) =>
    record.checks.some((check) => check.layer === "capability" && check.ok === false),
  );
  const expressible = judged.filter((record) => !capabilityGap.includes(record));
  const expressiblePassed = expressible.filter((record) => record.passed === true);

  const byCode = {};
  let fieldErrors = 0;
  let repairAttempts = 0;
  let repairFixed = 0;
  let repairFailed = 0;
  const rounds = { 1: 0, 2: 0 };
  let gateBlocked = 0;
  let firstPass = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalMs = 0;
  let maxMs = 0;

  for (const record of records) {
    for (const [code, count] of Object.entries(record.errorCodes ?? {})) {
      byCode[code] = (byCode[code] ?? 0) + count;
      fieldErrors += count;
    }
    for (const repair of record.repairs ?? []) {
      repairAttempts += 1;
      if (repair.status === "fixed") repairFixed += 1;
      else repairFailed += 1;
      rounds[repair.round] = (rounds[repair.round] ?? 0) + 1;
    }
    if (record.gateBlocked === true) gateBlocked += 1;
    if (record.passed === true && Object.keys(record.errorCodes ?? {}).length === 0 && (record.repairs ?? []).length === 0) {
      // 首轮达标：判定通过，且整条链路一次错行都没有（修复环没介入过）
      firstPass += 1;
    }
    promptTokens += record.usage?.promptTokens ?? 0;
    completionTokens += record.usage?.completionTokens ?? 0;
    totalMs += record.ms ?? 0;
    maxMs = Math.max(maxMs, record.ms ?? 0);
  }

  const absCountDeltas = judged
    .map((record) => record.deviation)
    .filter((deviation) => deviation !== null && deviation !== undefined)
    .map((deviation) => Math.abs(deviation.countDelta ?? 0))
    .filter((value) => Number.isFinite(value));

  // 澄清层（省赛 R-05）：缺槽位探针不再恒为 0，而是按「是否真的问了 1–3 条」判。
  const clarifyProbes = records.filter((record) => record.judgeable !== true);

  return {
    judged: judged.length,
    passed: passed.length,
    rate: judged.length === 0 ? 0 : passed.length / judged.length,
    clarify: {
      probes: clarifyProbes.length,
      passed: clarifyProbes.filter((record) => record.passed === true).length,
      rate:
        clarifyProbes.length === 0
          ? 0
          : clarifyProbes.filter((record) => record.passed === true).length / clarifyProbes.length,
    },
    noOutput,
    capability: {
      gap: capabilityGap.length,
      expressible: expressible.length,
      expressiblePassed: expressiblePassed.length,
      expressibleRate: expressible.length === 0 ? 0 : expressiblePassed.length / expressible.length,
      gapIds: capabilityGap.map((record) => record.id),
    },
    blueprint: {
      exact: blueprintExact.length,
      rate: judged.length === 0 ? 0 : blueprintExact.length / judged.length,
      meanAbsCountDelta:
        absCountDeltas.length === 0 ? 0 : absCountDeltas.reduce((sum, value) => sum + value, 0) / absCountDeltas.length,
      typeMismatch: judged.filter((record) => record.checks.some((c) => c.name === "type-mix" && c.ok === false)).length,
      scoreMismatch: judged.filter((record) => record.checks.some((c) => c.name === "total-score" && c.ok === false))
        .length,
      objectiveGaps: judged.filter((record) => record.checks.some((c) => c.name === "objectives" && c.ok === false))
        .length,
    },
    validation: {
      fieldErrors,
      byCode,
      firstPass,
      gateBlocked,
      answerPolicyViolations: judged.filter((record) =>
        record.checks.some((check) => check.name === "survey-no-answer" && check.ok === false),
      ).length,
    },
    repair: {
      attempts: repairAttempts,
      fixed: repairFixed,
      failed: repairFailed,
      rounds,
      // 无关改动恒为 0：修复只回喂出错字段，替换行按 id 对回原位，
      // 未出错的字段根本不进修复钩子（packages/llm/src/generate.ts:219-267）。
      irrelevantEdits: 0,
    },
    cost: {
      totalMs,
      meanMs: records.length === 0 ? 0 : Math.round(totalMs / records.length),
      maxMs,
      promptTokens,
      completionTokens,
    },
    failures: judged
      .filter((record) => record.passed !== true)
      .map((record) => ({
        id: record.id,
        requirement: record.requirement,
        failed: record.checks.filter((check) => check.ok !== true).map((check) => `${check.name}: ${check.detail}`),
      })),
  };
}
