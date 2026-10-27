"""生成 eval/requirements.jsonl：30 条需求，逐条带结构化预期。

为什么用脚本生成而不是手写 JSONL：三条预置需求必须与 `packages/schema/src/presets.ts`
逐字一致（回放 hash 按原文算），手抄一个字就会让 replay 全部未命中；脚本里可以直接
从 presets 源文件读取，杜绝漂移。

用法：python eval/gen_requirements.py [--check]
  --check  只校验现有文件与 presets 是否一致、行数是否为 30，不重写
"""

import hashlib
import importlib.util
import json
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "eval" / "requirements.jsonl"
PRESETS = ROOT / "packages" / "schema" / "src" / "presets.ts"


def presets_from_source():
    """从 presets.ts 里抠出 requirement 原文，按出现顺序返回。"""
    text = PRESETS.read_text(encoding="utf-8")
    # requirement: "..." 后面紧跟的字符串字面量，允许折行
    found = re.findall(r'requirement:\s*"([^"]+)"', text)
    if len(found) != 3:
        raise SystemExit(f"presets.ts 里应有 3 条 requirement，实际 {len(found)} 条")
    return found


def build():
    math_req, eng_req, bio_req = presets_from_source()

    rows = [
        # ── 与 fixtures/replays 对齐的三条（replay 模式唯一能跑的样本）────────
        {
            "id": "preset-math-quadratic",
            "set": "debug",
            "judgeable": True,
            "source": "preset",
            "requirement": math_req,
            "expect": {
                "kind": "quiz",
                "count": 8,
                "types": {"single": 4, "fill": 2, "short": 2},
                "totalScore": 40,
                "objectives": ["开口方向", "顶点坐标", "对称轴"],
            },
        },
        {
            "id": "preset-english-vocab",
            "set": "debug",
            "judgeable": True,
            "source": "preset",
            "requirement": eng_req,
            "expect": {
                "kind": "quiz",
                "count": 10,
                "types": {"single": 6, "fill": 2, "short": 2},
                "totalScore": 50,
                "objectives": ["动词短语"],
            },
        },
        {
            "id": "preset-bio-survey",
            "set": "debug",
            "judgeable": True,
            "source": "preset",
            "requirement": bio_req,
            "expect": {
                "kind": "survey",
                "count": 8,
                "types": {"single": 3, "scale": 2, "fill": 2, "short": 1},
                "noAnswers": True,
            },
        },
        # ── 其余判分需求：题量、题型、分值全部写死在需求文本里 ──────────────────
        ("q02-linear-equation", "debug",
         "出一份初一数学一元一次方程的随堂小测，6 道题：4 道单选、2 道填空，每题 5 分，共 30 分，覆盖移项和合并同类项。",
         {"kind": "quiz", "count": 6, "types": {"single": 4, "fill": 2}, "totalScore": 30,
          "objectives": ["移项", "合并同类项"]}),
        ("q03-refraction", "debug",
         "初二物理《光的折射》课堂检测，5 道题：3 道单选、2 道填空，共 25 分，每题 5 分。",
         {"kind": "quiz", "count": 5, "types": {"single": 3, "fill": 2}, "totalScore": 25}),
        ("q04-chemical-equation", "debug",
         "初三化学化学方程式专题练习，8 道题：4 道单选、2 道填空、2 道简答，共 40 分，每题 5 分。",
         {"kind": "quiz", "count": 8, "types": {"single": 4, "fill": 2, "short": 2}, "totalScore": 40}),
        ("q05-classical-particle", "debug",
         "高一语文文言虚词辨析小测，6 道题：4 道单选、2 道简答，共 30 分，每题 5 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 4, "short": 2}, "totalScore": 30}),
        ("q06-modern-history", "debug",
         "高三历史中国近代史的单元测验，10 道题：6 道单选、2 道填空、2 道简答，共 50 分，每题 5 分。",
         {"kind": "quiz", "count": 10, "types": {"single": 6, "fill": 2, "short": 2}, "totalScore": 50}),
        ("q07-fraction-add", "debug",
         "小学四年级数学分数加减法随堂测，6 道题：3 道单选、2 道填空、1 道简答，每题 5 分，共 30 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 3, "fill": 2, "short": 1}, "totalScore": 30}),
        ("q08-mole", "debug",
         "高一化学物质的量（摩尔）小测，5 道题：3 道单选、1 道填空、1 道数值题，共 25 分，每题 5 分。",
         {"kind": "quiz", "count": 5, "types": {"single": 3, "fill": 1, "number": 1}, "totalScore": 25}),
        ("q09-cell", "debug",
         "初二生物细胞结构随堂测，6 道题：3 道单选、2 道填空、1 道简答，共 30 分，每题 5 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 3, "fill": 2, "short": 1}, "totalScore": 30}),
        ("q10-sequence", "debug",
         "高二数学数列求和的专题测验，8 道题：4 道单选、2 道填空、2 道简答，共 40 分，每题 5 分。",
         {"kind": "quiz", "count": 8, "types": {"single": 4, "fill": 2, "short": 2}, "totalScore": 40}),
        ("q11-tense", "debug",
         "初一英语时态专项练习，6 道题：4 道单选、2 道填空，共 30 分，每题 5 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 4, "fill": 2}, "totalScore": 30}),
        ("q12-poem-recite", "debug",
         "小学六年级语文古诗默写检测，5 道题：3 道填空、2 道简答，共 25 分，每题 5 分。",
         {"kind": "quiz", "count": 5, "types": {"fill": 3, "short": 2}, "totalScore": 25}),
        ("q13-induction", "debug",
         "高三物理电磁感应综合测验，10 道题：5 道单选、3 道填空、2 道简答，共 50 分，每题 5 分。",
         {"kind": "quiz", "count": 10, "types": {"single": 5, "fill": 3, "short": 2}, "totalScore": 50}),
        ("q14-climate", "debug",
         "初二地理气候类型随堂测，6 道题：4 道单选、2 道填空，共 30 分，每题 5 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 4, "fill": 2}, "totalScore": 30}),
        # ── 保留样本：调 Prompt 时不许看这 14 条的结果 ─────────────────────────
        ("q15-stress-survey", "holdout",
         "做一个高一年级学习压力调查问卷，8 道题：3 道单选、2 道量表题、2 道填空、1 道简答。这是问卷，不要标准答案，也不要分值。",
         {"kind": "survey", "count": 8, "types": {"single": 3, "scale": 2, "fill": 2, "short": 1},
          "noAnswers": True}),
        ("q16-service-survey", "holdout",
         "做一份初三课后服务满意度问卷，6 道题：3 道单选、2 道量表题、1 道简答。问卷不要答案和分值。",
         {"kind": "survey", "count": 6, "types": {"single": 3, "scale": 2, "short": 1}, "noAnswers": True}),
        ("q17-family-survey", "holdout",
         "做一份小学家长家庭教育情况调查，6 道题：2 道单选、2 道量表题、2 道简答。属于问卷，不要标准答案，也不要分数。",
         {"kind": "survey", "count": 6, "types": {"single": 2, "scale": 2, "short": 2}, "noAnswers": True}),
        ("q18-philosophy", "holdout",
         "高二政治哲学基础小测，6 道题：4 道单选、2 道简答，共 30 分，每题 5 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 4, "short": 2}, "totalScore": 30}),
        ("q19-data-processing", "holdout",
         "初一信息技术数据处理测验，5 道题：3 道单选、2 道数值题，共 25 分，每题 5 分。",
         {"kind": "quiz", "count": 5, "types": {"single": 3, "number": 2}, "totalScore": 25}),
        ("q20-cloze", "holdout",
         "初三英语完形与语法综合测验，8 道题：6 道单选、2 道填空，共 40 分，每题 5 分。",
         {"kind": "quiz", "count": 8, "types": {"single": 6, "fill": 2}, "totalScore": 40}),
        ("q21-set-theory", "holdout",
         "高一数学集合运算小测，6 道题：3 道单选、2 道填空、1 道简答，共 30 分，每题 5 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 3, "fill": 2, "short": 1}, "totalScore": 30}),
        ("q22-diplomacy", "holdout",
         "初二历史新中国外交成就小测，5 道题：3 道单选、2 道简答，共 25 分，每题 5 分。",
         {"kind": "quiz", "count": 5, "types": {"single": 3, "short": 2}, "totalScore": 25}),
        ("q23-lab-interest", "holdout",
         "做一份高二生物实验兴趣问卷，6 道题：3 道单选、1 道量表题、2 道填空。问卷，不要答案，不要分值。",
         {"kind": "survey", "count": 6, "types": {"single": 3, "scale": 1, "fill": 2}, "noAnswers": True}),
        ("q24-organic", "holdout",
         "高三化学有机推断专项测验，4 道题：2 道单选、2 道简答，共 20 分，每题 5 分。",
         {"kind": "quiz", "count": 4, "types": {"single": 2, "short": 2}, "totalScore": 20}),
        ("q25-time-calc", "holdout",
         "小学三年级数学时间计算随堂测，6 道题：4 道单选、2 道填空，每题 5 分，共 30 分。",
         {"kind": "quiz", "count": 6, "types": {"single": 4, "fill": 2}, "totalScore": 30}),
        ("q26-color", "holdout",
         "初一美术色彩基础小测，5 道题：3 道单选、2 道简答，共 25 分，每题 5 分。",
         {"kind": "quiz", "count": 5, "types": {"single": 3, "short": 2}, "totalScore": 25}),
        # ── 澄清层探针：槽位不全，本应先追问（产品当前不追问，见 README）────────
        ("c01-vague-english", "holdout",
         "帮我出一份英语卷子",
         {"kind": "quiz", "count": 0, "types": {}, "clarifyNeeded": True}),
        ("c02-vague-survey", "holdout",
         "做个问卷",
         {"kind": "survey", "count": 0, "types": {}, "clarifyNeeded": True}),
    ]

    head = rows[:3]
    tail = []
    for rid, set_name, requirement, expect in rows[3:]:
        tail.append(
            {
                "id": rid,
                "set": set_name,
                # 澄清探针（c 开头）不参与主指标：它们缺槽位，判「达标」没有意义
                "judgeable": not rid.startswith("c"),
                "requirement": requirement,
                "expect": expect,
            }
        )

    return head + tail


def main():
    rows = build()
    assert len(rows) == 30, f"需求集应为 30 条，实际 {len(rows)}"
    judgeable = [row for row in rows if row["judgeable"]]
    text = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n"

    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        same = current == text
        print(f"行数={len(rows)} 可判={len(judgeable)} 与磁盘一致={same}")
        print(f"sha256={hashlib.sha256(text.encode('utf-8')).hexdigest()}")
        raise SystemExit(0 if same else 1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"写入 {OUT.relative_to(ROOT)}  行数={len(rows)} 可判={len(judgeable)}")
    print(f"debug={sum(1 for row in rows if row['set'] == 'debug')} "
          f"holdout={sum(1 for row in rows if row['set'] == 'holdout')}")
    print(f"sha256={hashlib.sha256(text.encode('utf-8')).hexdigest()}")


if __name__ == "__main__":
    main()
