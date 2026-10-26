#!/usr/bin/env node
/**
 * 零依赖密钥 / 个人信息扫描器。
 *
 * 为什么自己写而不是直接依赖 gitleaks：
 *   1. 评委与 CI 都必须「零安装」跑得起来，gitleaks 是二进制，不保证在干净环境里存在；
 *   2. 本项目还有一条 gitleaks 覆盖不到的自有约束——真实手机号 / 身份证号不得入库。
 * 所以策略是：装了 gitleaks 就用它做全历史扫描（更全），没装就用本脚本兜住
 * pre-commit 与 CI 的最低要求。二者共用同一份「什么算泄露」的语义。
 *
 * 用法：
 *   node scripts/secret-scan.mjs            # 扫描当前工作区已跟踪文件
 *   node scripts/secret-scan.mjs --staged   # 扫描 git 暂存区（pre-commit 使用）
 *   node scripts/secret-scan.mjs --history  # 扫描全部提交历史（CI 使用，较慢）
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".7z",
  ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".mp3", ".wasm", ".db", ".sqlite",
]);

const SKIP_PATHS = ["node_modules/", ".git/", "dist/", "coverage/", "pnpm-lock.yaml"];

/**
 * 规则表。正则刻意写成不会匹配到本文件自身的形式
 * （例如私钥标记不写完整字面量），否则扫描器会把自己报成泄露。
 */
const RULES = [
  {
    id: "llm-api-key",
    description: "OpenAI 兼容协议 API Key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "llm-api-key-env",
    description: "环境变量里写死的 Key（形如 LLM_API_KEY=...）",
    // 只认 UPPER_SNAKE 形态，避免把 `needsApiKey: requiresUpstream(...)` 这类代码误判为泄露
    regex: /\b[A-Z][A-Z0-9_]*(API_KEY|TOKEN|SECRET)\s*=\s*["']?[A-Za-z0-9_-]{24,}/g,
  },
  {
    id: "llm-api-key-literal",
    description: "字符串字面量里的 Key（形如 apiKey: \"...\"）",
    // 必须被引号包裹：无引号的多半是标识符引用，误报会让人关掉整个扫描
    regex: /\b(api[_-]?key|secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/gi,
  },
  {
    id: "aws-access-key",
    description: "AWS Access Key ID",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub Token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: "private-key-block",
    description: "私钥块",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: "cn-mobile",
    description: "中国大陆手机号",
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
  {
    id: "cn-id-card",
    description: "中国大陆身份证号",
    regex: /(?<!\d)\d{17}[\dXx](?!\d)/g,
  },
];

const ALLOW_MARKER = "secret-scan:allow";

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function shouldSkip(path) {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  return SKIP_PATHS.some((prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`));
}

function mask(value) {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/** 扫描一段文本，返回命中的行号与脱敏片段。 */
function scanText(path, text) {
  const findings = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(line)) !== null) {
        const hit = match[0];
        findings.push({
          path,
          line: index + 1,
          rule: rule.id,
          description: rule.description,
          sample: mask(hit),
        });
        if (match[0].length === 0) break;
      }
    }
  }
  return findings;
}

function readStagedFile(path) {
  return git(["show", `:${path}`]);
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    .split("\u0000")
    .filter(Boolean);
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\u0000").filter(Boolean);
}

function scanStaged() {
  const findings = [];
  for (const path of stagedFiles()) {
    if (shouldSkip(path)) continue;
    findings.push(...scanText(path, readStagedFile(path)));
  }
  return findings;
}

function scanWorktree() {
  const findings = [];
  for (const path of trackedFiles()) {
    if (shouldSkip(path)) continue;
    try {
      if (statSync(path).size > MAX_BYTES) continue;
      findings.push(...scanText(path, readFileSync(path, "utf8")));
    } catch {
      // 文件在索引中但工作区已删除：跳过，不视为失败。
    }
  }
  return findings;
}

/** 扫描全部历史：逐 commit 逐行检查 patch，命中时能定位到 commit。 */
function scanHistory() {
  return new Promise((resolve, reject) => {
    const findings = [];
    const child = spawn("git", ["log", "--all", "-p", "--no-color", "--format=commit %H"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let commit = "unknown";
    let path = "unknown";
    let lineNo = 0;
    let buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("commit ")) {
          commit = line.slice(7).trim();
          continue;
        }
        const diffMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (diffMatch?.[2] !== undefined) {
          path = diffMatch[2];
          continue;
        }
        if (line.startsWith("@@")) {
          const hunk = /\+(\d+)/.exec(line);
          lineNo = hunk?.[1] === undefined ? 0 : Number(hunk[1]) - 1;
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          lineNo += 1;
          if (shouldSkip(path) || line.includes(ALLOW_MARKER)) continue;
          const body = line.slice(1);
          for (const rule of RULES) {
            rule.regex.lastIndex = 0;
            if (rule.regex.test(body)) {
              findings.push({
                path: `${commit.slice(0, 8)}:${path}`,
                line: lineNo,
                rule: rule.id,
                description: rule.description,
                sample: mask(String(rule.regex.exec(body)?.[0] ?? body.trim()).slice(0, 24)),
              });
            }
          }
        }
      }
    });
    child.on("error", reject);
    child.on("close", () => resolve(findings));
  });
}

function report(findings, label) {
  if (findings.length === 0) {
    process.stdout.write(`secret-scan: ${label} 通过（0 命中）\n`);
    return 0;
  }
  process.stderr.write(`secret-scan: ${label} 发现 ${findings.length} 处疑似泄露\n\n`);
  for (const finding of findings) {
    process.stderr.write(
      `  ${finding.path}:${finding.line}  [${finding.rule}] ${finding.description}  ${finding.sample}\n`,
    );
  }
  process.stderr.write(
    "\n处理方式：删除内容 → 改写到 .env（本地）→ 若已进入历史，用 git filter-repo 清理并轮换密钥。\n" +
      "误报可在该行加注释 " +
      ALLOW_MARKER +
      "。\n",
  );
  return 1;
}

async function main() {
  const arg = process.argv[2] ?? "";
  if (arg === "--history") {
    process.exitCode = report(await scanHistory(), "全历史扫描");
    return;
  }
  if (arg === "--staged") {
    process.exitCode = report(scanStaged(), "暂存区扫描");
    return;
  }
  if (arg === "" ) {
    process.exitCode = report(scanWorktree(), "工作区扫描");
    return;
  }
  process.stderr.write(`未知参数：${arg}；可用 --staged / --history\n`);
  process.exitCode = 2;
}

await main();
