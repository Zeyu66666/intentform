#!/usr/bin/env node
/**
 * 浏览器闭环脚本：用**真 Chrome** 走一遍「登录 → 生成 → 发布 → 学生填 → 看板」。
 *
 * 为什么要有它：`scripts/verify.mjs` 用 fetch 证明了接口对得上，但证不了**前端真的渲染、
 * 真的能点**。评审看到的"跑通"如果只存在于 curl 输出里，那就不是最小浏览器闭环。
 * 这个脚本把每一步的 DOM 断言与截图一起留下，作为 `docs/evidence/` 里的证据。
 *
 * 用法（在仓库根）：
 *   node scripts/browser-closed-loop.mjs
 *
 * 环境变量：
 *   CHROME_PATH      Chrome/Edge 可执行文件；缺省按 Windows 常见安装路径逐个试。
 *   EVIDENCE_DIR     截图目录，缺省 `docs/evidence`（相对仓库根）。
 *   KEEP_RUN_DIR=1   保留临时目录（库文件、vite 日志、chrome 用户目录），默认跑完删掉。
 *
 * 它自己起两个进程，跑完全部收掉：
 *   1. `server/src/seed.ts`（一次性写入演示教师 + 2 张表单 + 30 条提交，库在临时目录）；
 *   2. `server/src/main.ts`，`NODE_ENV=production` + `WEB_INDEX_HTML=web/dist/index.html`
 *     （生产构建由同一个 Node 服务托管，确定性生成流不联网、不花额度）；
 * 然后启动 headless Chrome，用 **CDP**（WebSocket + JSON-RPC）驱动页面。
 * 不装任何依赖：`fetch` 与全局 `WebSocket` 都是 Node 内置。
 *
 * 端口全是临时找的空闲端口：服务端口、vite 端口、Chrome 调试端口互不复用，
 * 所以本机已经跑着 8787/5173 的时候也能并行跑这个脚本。
 *
 * 退出码：0 = 全绿；1 = 某步断言失败（会打印失败的那一步与原因）；2 = 找不到浏览器。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = join(ROOT, "server", "src", "main.ts");
const SEED_ENTRY = join(ROOT, "server", "src", "seed.ts");
const EVIDENCE_DIR = resolve(ROOT, process.env["EVIDENCE_DIR"] ?? join("docs", "evidence"));

/** 演示账号：`server/src/seed.ts` 里写死的那个（密码只在本机演示库生效）。 */
const DEMO_EMAIL = "teacher@example.com";
const DEMO_PASSWORD = "intentform-demo";

/**
 * 生成用的需求文本。刻意不含「问卷/调查/反馈」这类词：`inferFormKind` 见到就会把表单
 * 判成 survey，而 survey 不许有答案与分值（R3），学生页就没有"作答→判分"可走了。
 */
// 需求写全（题量 / 题型 / 分值 / 知识点都点明）：第 2 步只验流式渲染，
// 澄清交互单独放在第 9 步，两件事不挤在同一个步骤里互相掩盖。
const REQUIREMENT = "出一份二次函数随堂测：单选、填空、数值和简答各一道，共 25 分，覆盖开口方向与顶点坐标";

/** 桌面视口（教师侧）与学生手机视口（学生侧）。 */
const DESKTOP_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const DEFAULT_CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["PROGRAMFILES"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  // Chromium 系都讲 CDP，本机只装了 Edge 时也能跑（脚本不依赖 Chrome 私有行为）。
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

// ── 进程与端口 ────────────────────────────────────────────────────────────

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("拿不到空闲端口"));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

const sleepMs = sleep;

async function waitFor(check, label, timeoutMs = 20_000, intervalMs = 120) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待超时（${String(timeoutMs)}ms）：${label}`);
    }
    await sleepMs(intervalMs);
  }
}

/** 把子进程连同它的子树一起杀掉：Windows 上 Chrome 会 fork 一堆渲染进程。 */
function killTree(child) {
  if (child === undefined || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function collect(child, sink) {
  child.stdout?.on("data", (chunk) => sink.stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk) => sink.stderr.push(String(chunk)));
}

/**
 * 尽力删除临时目录，**绝不让清理失败拖垮一次成功的运行**。
 *
 * Windows 上 Chrome 刚被 `taskkill /T /F` 杀掉时，句柄释放有延迟：目录里还剩着
 * `DevToolsActivePort`、`SingletonLock`、缓存文件，`rmSync` 会抛 `EPERM`。
 * 这个错误唯一的具体后果是"临时目录没删掉"——把它变成 exit 1 会让一次 6 步全绿
 * 的验证看起来像失败，比不删脏得多。所以：多试几次；还不行就打印路径，让人自己删。
 */
async function removeDirQuietly(dir) {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      return true;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      if (attempt === attempts) {
        process.stderr.write(
          `[loop] 警告：临时目录删不掉（${code}），已保留：${dir}\n` +
            "[loop] 这不影响本次验证结果；可以稍后手动删除，或下次用 KEEP_RUN_DIR=1 直接保留。\n",
        );
        return false;
      }
      await sleepMs(300 * attempt);
    }
  }
  return false;
}

async function runToCompletion(entry, env, label) {
  const sink = { stdout: [], stderr: [] };
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collect(child, sink);
  const code = await new Promise((resolveCode) => {
    child.on("exit", (exitCode) => {
      resolveCode(exitCode);
    });
  });
  if (code !== 0) {
    throw new Error(`${label} 失败（exit ${String(code)}）：\n${sink.stderr.join("")}${sink.stdout.join("")}`);
  }
}

async function spawnServer(env, port) {
  const sink = { stdout: [], stderr: [] };
  const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collect(child, sink);
  const banner = `127.0.0.1:${String(port)}`;
  await waitFor(
    () => sink.stdout.join("").includes(banner),
    `服务启动（等启动横幅里出现 ${banner}；stderr=${sink.stderr.join("").slice(-400)}）`,
    30_000,
  );
  return { child, sink };
}

async function buildWeb() {
  const command = process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "pnpm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd --filter @intentform/web build"]
      : ["--filter", "@intentform/web", "build"];
  const sink = { stdout: [], stderr: [] };
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  collect(child, sink);
  const code = await new Promise((resolveCode) => child.on("exit", resolveCode));
  if (code !== 0) {
    throw new Error(`生产前端构建失败（exit ${String(code)}）：\n${sink.stderr.join("")}${sink.stdout.join("")}`);
  }
}

async function spawnProductionServer(env, port) {
  const server = await spawnServer(env, port);
  return server;
}

function resolveChrome() {
  const explicit = process.env["CHROME_PATH"];
  if (explicit !== undefined && explicit !== "") {
    if (!existsSync(explicit)) {
      throw new MissingBrowserError(`CHROME_PATH 指向的文件不存在：${explicit}`);
    }
    return explicit;
  }
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (candidate !== "" && existsSync(candidate)) return candidate;
  }
  throw new MissingBrowserError(
    [
      "找不到 Chrome/Edge。按顺序试过：",
      ...DEFAULT_CHROME_CANDIDATES.filter((path) => path !== "").map((path) => `  - ${path}`),
      "用 CHROME_PATH=<可执行文件> 显式指定一个 Chromium 系浏览器。",
    ].join("\n"),
  );
}

class MissingBrowserError extends Error {}

async function spawnChrome(executable, debugPort, userDataDir) {
  const args = [
    "--headless=new",
    // 当前 Windows 受限运行环境无法为独立临时 profile 建立 Chromium sandbox；
    // profile 与端口仍然完全隔离，去掉此参数会在 Page.enable 前关闭 page target。
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // Chrome 111+ 拒绝带 Origin 的 CDP WebSocket；脚本直连调试端口，所以放开来源检查。
    "--remote-allow-origins=*",
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,800",
    "about:blank",
  ];
  const sink = { stdout: [], stderr: [] };
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  collect(child, sink);
  const listUrl = `http://127.0.0.1:${String(debugPort)}/json/list`;
  const target = await waitFor(
    async () => {
      const response = await fetch(listUrl).catch(() => null);
      if (response === null || !response.ok) return null;
      const targets = await response.json();
      return targets.find((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string") ?? null;
    },
    `Chrome 调试端口就绪（stderr=${sink.stderr.join("").slice(-400)}）`,
    30_000,
    200,
  );
  return { child, sink, target };
}

// ── 极简 CDP 客户端（JSON-RPC over WebSocket）──────────────────────────────

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error === undefined) entry.resolve(message.result);
      else entry.reject(new Error(`CDP ${entry.method} 失败：${JSON.stringify(message.error)}`));
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`CDP 连接在 ${entry.method} 之前关闭`));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => {
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        rejectOpen(new Error(`连不上 CDP：${wsUrl}`));
      }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

/**
 * 页面内可用的几个小工具，注入到每次 `evaluate` 的 IIFE 里。
 *
 * `setValue` 必须走原型上的原生 setter：React 给 `input` 挂了受控的 `value`，
 * 直接 `el.value = x` 只会改 DOM 不改 state，提交出去的还是空答案。
 */
const PAGE_HELPERS = `
  function bySelector(selector) { return document.querySelector(selector); }
  function byTestId(id) { return document.querySelector('[data-testid="' + id + '"]'); }
  function clickSelector(selector) {
    var el = bySelector(selector);
    if (el === null) return false;
    el.click();
    return true;
  }
  function setValue(selector, value) {
    var el = bySelector(selector);
    if (el === null) return { ok: false, reason: 'missing ' + selector };
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: el.value };
  }
  function bodyText() { return document.body === null ? '' : document.body.innerText; }
  function buttonLabels() {
    return Array.prototype.map.call(document.querySelectorAll('button'), function (button) {
      return (button.textContent || '').trim();
    });
  }
  function clickButtonByText(pattern) {
    var re = new RegExp(pattern);
    var buttons = document.querySelectorAll('button');
    for (var index = 0; index < buttons.length; index += 1) {
      if (re.test((buttons[index].textContent || '').trim())) {
        buttons[index].click();
        return true;
      }
    }
    return false;
  }
`;

class Page {
  constructor(cdp) {
    this.cdp = cdp;
  }

  async evaluate(body) {
    const response = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => { ${PAGE_HELPERS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails !== undefined) {
      const detail = response.exceptionDetails;
      throw new Error(`页面内脚本抛错：${detail.exception?.description ?? detail.text ?? "未知"}`);
    }
    return response.result.value;
  }

  async viewport(metrics) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", metrics);
  }

  async goto(url) {
    await this.cdp.send("Page.navigate", { url });
    await waitFor(
      async () => (await this.evaluate("return document.readyState")),
      `页面加载 ${url}`,
    );
    await waitFor(
      async () => (await this.evaluate("return document.readyState === 'complete'")),
      `页面加载完成 ${url}`,
    );
  }

  async text() {
    return await this.evaluate("return bodyText()");
  }

  /**
   * 真的"点"一下：取元素中心坐标，发 `Input.dispatchMouseEvent`。
   *
   * 为什么不用 `element.click()` 而要走 CDP 鼠标事件：
   * 1. **可信度**：`Input.dispatchMouseEvent` 是浏览器认可的输入，和真人手指同一条路径
   *    （命中测试、`:active`、默认行为、事件顺序全都真实）。`element.click()` 只发一个
   *    `isTrusted=false` 的合成事件，绕过了命中测试——它证明不了"这个控件点得到"。
   * 2. **能顺带量触控目标**：取到元素的 `getBoundingClientRect()` 才能断言 ≥44px 的热区，
   *    这正是学生页要求的可点性指标。
   *
   * 一次归因修正（别再被我上一版注释误导）：学生页曾出现"点完之后 `input.checked` 恒为
   * false、整组 `input[name=x]` 全是 0"。那不是合成事件的问题，而是 web 侧
   * `selectedValues()` 只认数组、而单选在 state 里存的是字符串，导致 `checked` 永远算成
   * false；修在 `f63613d fix(web): make single-choice selection visible on the student page`。
   * 也就是说现在 `element.click()` 也能点亮，本脚本仍然用可信点击，理由是上面那两条。
   */
  async tap(selector) {
    const box = await this.evaluate(`
      var el = bySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.scrollIntoView({ block: 'center' });
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height, text: (el.textContent || '').trim().slice(0, 24) };
    `);
    if (box === null) return { ok: false, reason: `找不到元素 ${selector}` };
    if (box.w < 1 || box.h < 1) return { ok: false, reason: `元素不可见 ${selector}（${String(box.w)}×${String(box.h)}）` };
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true, heightPx: Math.round(box.h), widthPx: Math.round(box.w), text: box.text };
  }

  async path() {
    return await this.evaluate("return location.pathname");
  }

  async screenshot(fileName) {
    const shot = await this.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const target = join(EVIDENCE_DIR, fileName);
    writeFileSync(target, Buffer.from(shot.data, "base64"));
    return target;
  }
}

// ── 教师侧 HTTP（Node 里那份"带外"调用，只在 UI 按钮缺失时兜底）──────────────

function makeApi(baseUrl, appOrigin) {
  return async function request(method, path, options = {}) {
    const headers = { origin: appOrigin, "x-intentform-csrf": "1" };
    if (options.json !== undefined) headers["content-type"] = "application/json";
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, text, json: parsed, headers: response.headers };
  };
}

/** 把 SSE 文本切成事件对象。注释帧（心跳）没有 data，自然被丢掉。 */
function parseSse(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    let name = null;
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice("event: ".length).trim();
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (name === null || data === null) continue;
    events.push(JSON.parse(data));
  }
  return events;
}

// 进 totalScore 的题型：省赛 R-01 之后简答也带分值（它是"要老师批"的分，不是"自动判"的分）。
const SCORED_TYPES = new Set(["single", "multi", "fill", "number", "short"]);

/** 与 `scripts/verify.mjs` 同源的组装规则：节点顺序、objectives 去重、totalScore 求和（R6）。 */
function buildGeneratedQuiz(nodes) {
  const objectiveIds = [];
  for (const node of nodes) {
    const knowledgePoint = node.knowledgePoint;
    if (typeof knowledgePoint === "string" && !objectiveIds.includes(knowledgePoint)) {
      objectiveIds.push(knowledgePoint);
    }
  }
  const totalScore = nodes
    .filter((node) => SCORED_TYPES.has(node.type))
    .reduce((sum, node) => sum + node.score, 0);
  return {
    meta: {
      // scripts 不依赖业务包，所以这里是字面量；与 `SCHEMA_VERSION` 的一致性由 schema 包测试保证。
      version: 1,
      kind: "quiz",
      title: "浏览器闭环 · mock 生成卷",
      objectives: objectiveIds.map((id) => ({ id, name: id })),
      totalScore,
    },
    items: nodes,
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 看板「每题正确率」表的逐行文本（R-04）。
 *
 * 取每个单元格的 `textContent`：正确率那格包含数字文本与一根纯视觉的 CSS 条，
 * 条没有文本，所以第四格恰好是 `100%` / `—` 这样的字符串，可以直接断死。
 */
async function itemStatRows(page) {
  return page.evaluate(
    "return Array.prototype.map.call(document.querySelectorAll('[data-testid=dash-item-stat]'), function (tr) { return Array.prototype.map.call(tr.querySelectorAll('td'), function (td) { return td.textContent.trim(); }); });",
  );
}

/** 看板「知识点 × 布鲁姆覆盖」矩阵的行文本（R-07）。 */
async function coverageMatrixRows(page) {
  return page.evaluate(
    "var table = document.querySelector('[data-testid=dash-coverage-matrix]'); return table === null ? [] : Array.prototype.map.call(table.querySelectorAll('tbody tr'), function (tr) { return Array.prototype.map.call(tr.querySelectorAll('th,td'), function (cell) { return cell.textContent.trim(); }); });",
  );
}

const steps = [];
const artifacts = [];

async function step(name, body) {
  const startedAt = Date.now();
  process.stdout.write(`[loop] ${name} …\n`);
  try {
    const details = await body();
    steps.push({ name, ok: true, durationMs: Date.now() - startedAt, details });
    process.stdout.write(`[loop] ${name} … 通过（${String(Date.now() - startedAt)}ms）\n`);
    return details;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    steps.push({ name, ok: false, durationMs: Date.now() - startedAt, error: reason });
    throw error;
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const chrome = resolveChrome();
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const runDir = mkdtempSync(join(tmpdir(), "intentform-loop-"));
  const dbPath = join(runDir, "loop.db");
  const chromeProfile = join(runDir, "chrome-profile");
  const apiPort = await findFreePort();
  const debugPort = await findFreePort();
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;
  const webBase = apiBase;

  const env = {
    PORT: String(apiPort),
    DATABASE_PATH: dbPath,
    // 每次运行现生成：给密钥扫描器少一个假阳性，也不需要跨运行保持同一会话。
    SESSION_SECRET: `loop-session-${randomUUID()}`,
    SESSION_TTL_HOURS: "1",
    COOKIE_SECURE: "false",
    // 生产同源部署时页面与 API 共用一个来源（CSRF 逐字节比对 Origin）。
    APP_ORIGIN: webBase,
    NODE_ENV: "production",
    WEB_INDEX_HTML: join(ROOT, "web", "dist", "index.html"),
    LLM_MODE: "mock",
    ARGON2_MEMORY_KIB: "8192",
  };

  const children = [];
  let cdp = null;
  let failure = null;

  try {
    await buildWeb();
    await runToCompletion(SEED_ENTRY, env, "种子数据写入");
    const server = await spawnProductionServer(env, apiPort);
    children.push(server.child);
    const browser = await spawnChrome(chrome, debugPort, chromeProfile);
    children.push(browser.child);

    cdp = await Cdp.connect(browser.target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", DESKTOP_VIEWPORT);
    const page = new Page(cdp);

    const request = makeApi(apiBase, webBase);
    const csp = await fetch(`${webBase}/`, { headers: { accept: "text/html" } });
    const cspHeader = csp.headers.get("content-security-policy") ?? "";
    must(csp.ok, `生产首页不可访问（${String(csp.status)}）`);
    must(cspHeader.includes("script-src 'self'"), `生产首页缺少 script-src 'self'：${cspHeader}`);
    must(cspHeader.includes("style-src-attr 'unsafe-inline'"), `生产首页缺少 KaTeX style 放行：${cspHeader}`);
    must(!cspHeader.includes("script-src 'unsafe-inline'"), `CSP 不得放开脚本内联：${cspHeader}`);
    // 脚本自己在 Node 里也登一次：它要用这份会话去读表单详情（学生页得按 schema 答题）、
    // 以及在 UI 还没提供「保存并发布」时兜底建表单。浏览器有自己独立的会话 cookie。
    const nodeLogin = await request("POST", "/api/auth/login", {
      json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    must(nodeLogin.status === 200, `脚本侧登录失败（${String(nodeLogin.status)}）：${nodeLogin.text}`);
    const cookie = (nodeLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    must(cookie.startsWith("intentform_session="), "脚本侧没拿到会话 cookie");

    // 1) 登录
    const login = await step("登录（/login → /dashboard）", async () => {
      await page.goto(`${webBase}/login`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('input[name=email]') !== null")),
        "登录表单渲染",
      );
      // 截图取在填表之前：这张图要证明的是「会话建立前的入口」，不是登录后的看板
      artifacts.push(await page.screenshot("01-login.png"));
      const filled = await page.evaluate(`
        var email = setValue('input[name=email]', ${JSON.stringify(DEMO_EMAIL)});
        var password = setValue('input[name=password]', ${JSON.stringify(DEMO_PASSWORD)});
        var clicked = clickButtonByText('^登录$');
        return { email: email.ok, password: password.ok, clicked: clicked };
      `);
      must(filled.email && filled.password, `登录表单没填进去：${JSON.stringify(filled)}`);
      must(filled.clicked, "没找到「登录」按钮");
      await waitFor(async () => (await page.path()) === "/dashboard", "登录后跳到 /dashboard");
      await waitFor(
        async () => (await page.evaluate("return byTestId('dash-form-select') !== null")),
        "看板表单下拉渲染",
      );
      const forms = await page.evaluate(
        "return Array.prototype.map.call(document.querySelectorAll('[data-testid=dash-form-select] option'), function (o) { return o.textContent.trim(); });",
      );
      return { path: await page.path(), forms };
    });

    // 2) 生成
    const generate = await step("生成（输入需求 → SSE 流式渲染预览）", async () => {
      await page.goto(`${webBase}/`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('#requirement-input') !== null")),
        "生成页需求输入框渲染",
      );
      const typed = await page.evaluate(
        `return setValue('#requirement-input', ${JSON.stringify(REQUIREMENT)});`,
      );
      must(typed.ok === true, `需求没填进去：${JSON.stringify(typed)}`);
      must(
        await page.evaluate("return clickButtonByText('^生成表单$')"),
        "没找到「生成表单」按钮",
      );
      // R-06：生成前多了一步"确认蓝图"。需求写全时不会先追问，直接到蓝图卡。
      await waitFor(
        async () => (await page.evaluate("return byTestId('plan-card') !== null")),
        "蓝图卡片出现",
        20_000,
      );
      const planSummary = await page.evaluate(
        "var el = byTestId('plan-summary'); return el === null ? '' : el.textContent.trim();",
      );
      must(planSummary.length > 0, "蓝图卡片没有摘要");
      artifacts.push(await page.screenshot("02b-plan.png"));
      const confirmPlan = await page.tap('[data-testid=plan-confirm]');
      must(confirmPlan.ok === true, `点不到「按蓝图生成」：${JSON.stringify(confirmPlan)}`);
      // mock 是内置脚本 + 一条故意写坏再修复的题：等前端把 done 状态渲染出来。
      await waitFor(async () => (await page.text()).includes("生成完成"), "生成流走完（出现「生成完成」）", 30_000);
      artifacts.push(await page.screenshot("02-generate.png"));
      const source = await page.evaluate(
        "var el = byTestId('data-source'); return el === null ? '' : el.textContent.trim();",
      );
      const timeline = await page.text();
      must(timeline.includes("修复") || timeline.includes("repair"), "时间线里没有修复记录（mock 必然有一次）");
      // R-06 的界面级证据：时间线里必须真的出现 plan 阶段与蓝图摘要。
      must(timeline.includes("蓝图已确认"), "时间线里没有蓝图摘要（plan 阶段没发生）");
      return { requirement: REQUIREMENT, source, planSummary, sawRepairEntry: true };
    });

    // 3) 保存并发布
    //
    // UI 上还没有「保存并发布」按钮时（web 侧由另一位队友在加），这里退回到 API：
    // 用教师同一份凭据在 Node 侧创建并发布，**表单内容仍来自同一条 mock 生成流**
    // （mock 是确定性的，节点逐字相同），所以闭环的真实性不受影响，只是操作入口变了。
    // 按钮一旦上线，脚本会自动改走 UI 路径，不需要再改这里。
    const publish = await step("保存并发布（取学生短链 slug）", async () => {
      const hasPublishButton = await page.evaluate(
        "return buttonLabels().some(function (t) { return /发布/.test(t); })",
      );
      let mode = hasPublishButton ? "ui" : "api";
      if (hasPublishButton) {
        await page.evaluate("return clickButtonByText('发布')");
        try {
          await waitFor(async () => /\/f\/[a-z0-9]+/.test(await page.text()), "发布后页面出现学生短链", 12_000);
        } catch {
          // 按钮在、但没把 slug 露出来：不让整个脚本红在这里，退回 API 并把事实记进摘要。
          mode = "ui-failed-then-api";
        }
      }

      let formId = "";
      let versionId = "";
      let slug = "";

      if (mode === "ui") {
        slug = /\/f\/([a-z0-9]+)/.exec(await page.text())?.[1] ?? "";
        must(slug !== "", "发布成功但页面里没抓到 slug");
        const list = await request("GET", "/api/forms", { cookie });
        must(list.status === 200, `读表单列表失败（${String(list.status)}）`);
        const matched = (list.json.forms ?? []).find((form) => form.slug === slug);
        must(matched !== undefined, `表单列表里找不到 slug=${slug} 的那张（UI 发布的 formId 无从得知）`);
        formId = matched.id;
        versionId = matched.publishedVersionId ?? "";
      } else {
        const sse = await request("POST", "/api/generate", { json: { requirement: REQUIREMENT } });
        must(sse.status === 200, `兜底生成失败（${String(sse.status)}）：${sse.text}`);
        const nodes = parseSse(sse.text)
          .filter((event) => event.type === "field")
          .map((event) => event.node);
        must(nodes.length >= 4, `兜底生成只拿到 ${String(nodes.length)} 个节点`);
        const schema = buildGeneratedQuiz(nodes);

        const created = await request("POST", "/api/forms", {
          cookie,
          json: { title: schema.meta.title, kind: "quiz", schema, source: "generate" },
        });
        must(created.status === 201, `兜底建表单失败（${String(created.status)}）：${created.text}`);
        formId = created.json.form.id;
        versionId = created.json.version.id;
        const published = await request("POST", `/api/forms/${formId}/publish`, { cookie, json: { versionId } });
        must(published.status === 200, `兜底发布失败（${String(published.status)}）：${published.text}`);
        slug = published.json.slug;
        must(typeof slug === "string" && slug.length > 0, "发布没有返回 slug");
      }

      // 两张截图证明的是两件不同的事，不能合成一张：
      //   03a 生成页上的「已发布 + 学生链接」= 我确实点了发布；
      //   03b 看板里能查到同一张表单     = 发布的结果真的落库了。
      if (mode === "ui") artifacts.push(await page.screenshot("03a-publish-panel.png"));
      await page.goto(`${webBase}/dashboard/${formId}`);
      await waitFor(async () => (await page.text()).includes(`/f/${slug}`), "看板显示学生链接", 20_000);
      // 零提交时的每题正确率（R-04）：区块在，但每行的正确率必须是 `—`。
      // 显示 `0%` 会把「还没有人提交」读成「全班全错」——这正是本轮要防的误读，
      // 所以它必须在**还没有数据**的这一刻被断死，而不是只看有数据的样子。
      const emptyStats = await itemStatRows(page);
      must(emptyStats.length > 0, "看板上没有「每题正确率」区块");
      must(
        emptyStats.every((cells) => cells[3] === "—"),
        `零提交时正确率应显示 —（不是 0%），实际 ${JSON.stringify(emptyStats)}`,
      );
      const emptyCoverage = await coverageMatrixRows(page);
      must(emptyCoverage.length > 0, "看板上没有「知识点 × 布鲁姆覆盖」区块");
      must(
        emptyCoverage.every((cells) => cells.length === 7 && cells.slice(1).every((cell) => /^\d+$/.test(cell))),
        `零提交时覆盖矩阵应保留六个数值单元格，实际 ${JSON.stringify(emptyCoverage)}`,
      );
      artifacts.push(await page.screenshot("03b-published-dashboard.png"));
      return {
        mode,
        formId,
        versionId,
        slug,
        emptyStatRows: emptyStats,
        buttonLabels: await page.evaluate("return buttonLabels()"),
      };
    });

    // 4) 学生端（手机视口）
    const student = await step("学生页 390×844 打开并作答", async () => {
      await page.viewport(MOBILE_VIEWPORT);
      await page.goto(`${webBase}/f/${publish.slug}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('fill-submit') !== null")),
        "学生页渲染出提交按钮",
        20_000,
      );
      artifacts.push(await page.screenshot("04-student.png"));

      const formDetail = await request("GET", `/api/forms/${publish.formId}`, { cookie });
      must(formDetail.status === 200, `读表单详情失败（${String(formDetail.status)}）：${formDetail.text}`);
      const schema = formDetail.json.schema;
      const maxScore = schema.items
        .filter((item) => SCORED_TYPES.has(item.type))
        .reduce((sum, item) => sum + item.score, 0);

      // 全部答对：这样看板上的那一行分数是个确定的数字，能被断死。
      //
      // 选项类用 `tap`（可信鼠标事件，走浏览器默认行为），文本类用原型 setter + input 事件
      // （React 的 value tracker 只认这条路径）。点完立刻回读 DOM，不看返回值自说自话。
      const touched = [];
      for (const item of schema.items) {
        if (item.type === "single" && typeof item.answer === "string") {
          const hit = await page.tap(`[data-testid="fill-${item.id}-${item.answer}"]`);
          must(hit.ok === true, `点不到单选选项 ${item.id}/${item.answer}：${JSON.stringify(hit)}`);
          const state = await page.evaluate(`
            var label = byTestId(${JSON.stringify(`fill-${item.id}-${item.answer}`)});
            var input = label === null ? null : label.querySelector('input');
            return {
              checked: input === null ? null : input.checked === true,
              touchTarget: label === null ? 0 : Math.round(label.getBoundingClientRect().height),
            };
          `);
          must(state.checked === true, `单选 ${item.id} 点完仍未选中`);
          touched.push({ id: item.id, kind: "single", touchTarget: state.touchTarget });
        } else if (item.type === "multi" && Array.isArray(item.answer)) {
          for (const optionId of item.answer) {
            const hit = await page.tap(`[data-testid="fill-${item.id}-${optionId}"]`);
            must(hit.ok === true, `点不到多选选项 ${item.id}/${optionId}：${JSON.stringify(hit)}`);
            const checked = await page.evaluate(`
              var label = byTestId(${JSON.stringify(`fill-${item.id}-${optionId}`)});
              var input = label === null ? null : label.querySelector('input');
              return input !== null && input.checked === true;
            `);
            must(checked === true, `多选 ${item.id}/${optionId} 点完仍未选中`);
          }
          touched.push({ id: item.id, kind: "multi" });
        } else if (item.type === "number" && item.answer !== undefined && item.answer !== null) {
          const value = String(item.answer.value);
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', ${JSON.stringify(value)});`,
          );
          must(filled.ok === true, `数字题 ${item.id} 没填进去：${JSON.stringify(filled)}`);
          must(filled.value === value, `数字题 ${item.id} 的 value 回读不一致：${String(filled.value)}`);
          touched.push({ id: item.id, kind: "number", value });
        } else if (item.type === "fill" && Array.isArray(item.answer)) {
          const value = item.answer.join("／");
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', ${JSON.stringify(value)});`,
          );
          must(filled.ok === true, `填空题 ${item.id} 没填进去：${JSON.stringify(filled)}`);
          must(filled.value === value, `填空题 ${item.id} 的 value 回读不一致`);
          touched.push({ id: item.id, kind: "fill", value });
        } else if (item.type === "short") {
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', "浏览器闭环脚本填写");`,
          );
          must(filled.ok === true, `简答题 ${item.id} 没填进去：${JSON.stringify(filled)}`);
          touched.push({ id: item.id, kind: "short" });
        }
      }

      artifacts.push(await page.screenshot("05-student-answered.png"));
      return { slug: publish.slug, maxScore, answeredFields: touched.length, touched };
    });


    // 5) 提交并看到成功卡片
    const submitted = await step("提交答卷并看到成功卡片", async () => {
      const hit = await page.tap('[data-testid="fill-submit"]');
      must(hit.ok === true, `点不到提交按钮：${JSON.stringify(hit)}`);
      must(hit.heightPx >= 44, `提交按钮的触控高度只有 ${String(hit.heightPx)}px（应 ≥44px）`);
      await waitFor(async () => (await page.text()).includes("答案已记录"), "提交成功卡片", 20_000);
      artifacts.push(await page.screenshot("06-submitted.png"));
      const text = await page.text();
      const scoreLine = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
      must(scoreLine !== null, `成功卡片里没看到 得分/满分：${text.slice(0, 200)}`);
      const pendingLine = /其中\s*(\d+(?:\.\d+)?)\s*分待人工批改/.exec(text);
      return {
        score: Number(scoreLine[1]),
        maxScore: Number(scoreLine[2]),
        pending: pendingLine === null ? 0 : Number(pendingLine[1]),
        text: scoreLine[0],
      };
    });
    // 简答带分值之后（省赛 R-01），全部答对也不等于拿满分：客观题拿满、简答等教师批。
    // 断言「客观分 + 待批分 = 满分」，并把这个待批额记下来给第 7 步用。
    must(
      submitted.score + submitted.pending === student.maxScore,
      `客观 ${String(submitted.score)} + 待批 ${String(submitted.pending)} 应等于满分 ${String(student.maxScore)}`,
    );

    // 6) 看板看到新增行
    const dashboard = await step("看板看到新增提交行", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/dashboard/${publish.formId}`);
      const rowCount = await waitFor(
        async () => {
          const value = await page.evaluate("return document.querySelectorAll('[data-testid=dash-row]').length");
          return value > 0 ? value : null;
        },
        "看板出现提交行",
        20_000,
      );
      artifacts.push(await page.screenshot("07-dashboard.png"));
      const cells = await page.evaluate(
        "var row = document.querySelector('[data-testid=dash-row]'); return row === null ? [] : Array.prototype.map.call(row.querySelectorAll('td'), function (td) { return td.textContent.trim(); });",
      );
      const expectedScoreText = `${String(submitted.score)} / ${String(student.maxScore)}（另有 ${String(submitted.pending)} 分待批改）`;
      must(
        cells.includes(expectedScoreText),
        `看板第一行的得分应是「${expectedScoreText}」，实际 ${JSON.stringify(cells)}`,
      );
      // 每题正确率（R-04）：学生这份答卷是"全部答对"，所以每道可判分题的 rate 都是
      // 100%。这说明数字不是摆上去的，是看板真的从接口取、真的按题渲染出来的。
      const statCells = await itemStatRows(page);
      must(statCells.length > 0, "看板上没有「每题正确率」区块");
      must(
        statCells.every((cells) => cells[3] === "100%"),
        `全部答对时每题正确率应为 100%，实际 ${JSON.stringify(statCells)}`,
      );
      const coverage = await coverageMatrixRows(page);
      must(coverage.length > 0, "看板上没有覆盖矩阵行");
      must(
        coverage.some((cells) => cells.slice(1).some((cell) => cell !== "0")),
        `覆盖矩阵没有渲染实际题目标注，实际 ${JSON.stringify(coverage)}`,
      );
      const stats = await page.text();
      return {
        rowCount,
        firstRowCells: cells,
        expectedScoreText,
        itemStatRows: statCells,
        sawStats: stats.includes("提交数"),
      };
    });

    // 7) 教师批改：看板上把简答案批掉，确认分数真的从「待批改」变成确定值
    //
    // 这一步是省赛 R-02 的界面级证据。VC5 验的是 HTTP 语义，这里验的是
    // 「教师点得到按钮、批完看板自己变了」——少了这一步，批改功能只有接口没有入口。
    const graded = await step("教师批改简答案并看到分数更新", async () => {
      const open = await page.tap('[data-testid^="dash-grade-"]');
      must(open.ok === true, `点不到看板上的批改按钮：${JSON.stringify(open)}`);
      must(open.heightPx >= 44, `批改按钮触控高度只有 ${String(open.heightPx)}px（应 ≥44px）`);
      await waitFor(async () => (await page.text()).includes("批改"), "批改面板出现", 20_000);

      const answerText = await page.evaluate(
        "var el = document.querySelector('[data-testid^=grade-answer]'); return el === null ? null : el.textContent.trim();",
      );
      must(
        typeof answerText === "string" && answerText.length > 0,
        `批改面板里要能看到学生写的原文，实际 ${JSON.stringify(answerText)}`,
      );

      const filled = await page.evaluate(
        "var input = document.querySelector('[data-testid^=grade-input]'); if (input === null) return { ok: false }; var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '4'); input.dispatchEvent(new Event('input', { bubbles: true })); return { ok: true, value: input.value };",
      );
      must(filled.ok === true && filled.value === "4", `批改输入框没写进 4 分：${JSON.stringify(filled)}`);

      const save = await page.tap('[data-testid^="grade-save"]');
      must(save.ok === true, `点不到保存按钮：${JSON.stringify(save)}`);

      // 批 4 分：客观 20 + 人工 4 = 24，满分 25 不变；批完这条不再有待批改。
      const expectedAfter = `${String(submitted.score + 4)} / ${String(submitted.maxScore)}`;
      const cells = await waitFor(
        async () => {
          const value = await page.evaluate(
            "var row = document.querySelector('[data-testid=dash-row]'); return row === null ? null : Array.prototype.map.call(row.querySelectorAll('td'), function (td) { return td.textContent.trim(); });",
          );
          if (value === null) return null;
          return value.some((cell) => cell === expectedAfter) ? value : null;
        },
        `批改后看板分数变为 ${expectedAfter}`,
        20_000,
      );
      must(
        !cells.some((cell) => cell.includes("待批改")),
        `批完之后不应再有待批改提示，实际 ${JSON.stringify(cells)}`,
      );
      artifacts.push(await page.screenshot("08-graded.png"));
      return { gradedScore: 4, firstRowCells: cells, answerSeen: answerText.length };
    });

    // 8) 编辑器 + 一句话改：省赛 R-03 的界面级证据
    //
    // VC6/VC7 验的是 PATCH/撤销的 HTTP 语义；这里验「教师点得到、看得见 diff」。
    // mock 模式的建议是内置脚本（改写第一题题干），所以断言的是"建议被采用并落成 v2"，
    // 不是"模型读懂了这句话"——两者不能混为一谈。
    const edited = await step("编辑器里用一句话改一版再撤销", async () => {
      await page.goto(`${webBase}/forms/${publish.formId}/edit`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-save') !== null")),
        "编辑器渲染出保存按钮",
        20_000,
      );
      const before = await page.evaluate(
        "var el = byTestId('edit-form-meta'); return el === null ? '' : el.textContent.trim();",
      );
      must(before.includes("v1"), `刚打开应停在 v1，实际「${before}」`);
      artifacts.push(await page.screenshot("09-editor.png"));

      const typed = await page.evaluate(
        "return setValue('[data-testid=\"edit-suggest-input\"]', '把第一题题干改短一点');",
      );
      must(typed.ok === true, `一句话输入框没写进去：${JSON.stringify(typed)}`);

      const asked = await page.tap('[data-testid="edit-suggest-run"]');
      must(asked.ok === true, `点不到「生成改动建议」：${JSON.stringify(asked)}`);

      const proposal = await waitFor(
        async () => {
          const value = await page.evaluate(
            "var p = byTestId('edit-suggest-proposal'); return p === null ? null : (byTestId('edit-suggest-changes') || {}).textContent;",
          );
          return typeof value === "string" && value.length > 0 ? value : null;
        },
        "建议面板列出改动",
        20_000,
      );
      artifacts.push(await page.screenshot("10-suggest.png"));

      const adopted = await page.tap('[data-testid="edit-suggest-adopt"]');
      must(adopted.ok === true, `点不到「采用」：${JSON.stringify(adopted)}`);
      await waitFor(
        async () => (await page.evaluate("var el = byTestId('edit-form-meta'); return el !== null && el.textContent.indexOf('v2') >= 0;")),
        "采用后版本号变成 v2",
        20_000,
      );

      const undone = await page.tap('[data-testid="edit-undo"]');
      must(undone.ok === true, `点不到「撤销上一步」：${JSON.stringify(undone)}`);
      await waitFor(
        async () => (await page.evaluate("var el = byTestId('edit-form-meta'); return el !== null && el.textContent.indexOf('v1') >= 0;")),
        "撤销后回到 v1",
        20_000,
      );
      const notice = await page.evaluate(
        "var el = byTestId('edit-notice'); return el === null ? '' : el.textContent.trim();",
      );
      artifacts.push(await page.screenshot("11-editor-undone.png"));
      return { before, proposal: proposal.slice(0, 80), notice };
    });

    // 9) 意图澄清（省赛 R-05）：含糊需求先问 1–3 条，不答也能生成
    //
    // 这一步的命题只有两个：**追问是服务端真的判出来的**（不是前端写死的三连问），
    // 以及**跳过是真的能生成**（澄清是帮忙，不是关卡）。补答如何拼进需求由 VC8 负责，
    // 这里只看"问得到、看得见、跳得掉"。
    const clarify = await step("意图澄清：含糊需求 → 追问 → 跳过生成", async () => {
      await page.goto(`${webBase}/`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('#requirement-input') !== null")),
        "生成页需求输入框渲染",
      );
      const typed = await page.evaluate(
        `return setValue('#requirement-input', "帮我出一份英语卷子");`,
      );
      must(typed.ok === true, `需求没填进去：${JSON.stringify(typed)}`);
      must(
        await page.evaluate("return clickButtonByText('^生成表单$')"),
        "没找到「生成表单」按钮",
      );
      await waitFor(
        async () => (await page.evaluate("return byTestId('clarify-block') !== null")),
        "追问块出现",
        10_000,
      );
      const slots = await page.evaluate(
        "return Array.prototype.map.call(document.querySelectorAll('[data-testid^=clarify-question-]'), function (el) { return el.getAttribute('data-testid').replace('clarify-question-', ''); });",
      );
      must(
        slots.length >= 1 && slots.length <= 3,
        `追问应为 1–3 条，实际 ${String(slots.length)}：${JSON.stringify(slots)}`,
      );

      // 点一个快捷选项：界面要把「将写入什么」摆出来，而不是默默存着。
      const picked = await page.tap('[data-testid=clarify-question-count] button');
      must(picked.ok === true, `点不到题量选项：${JSON.stringify(picked)}`);
      const answerLine = await waitFor(
        async () => {
          const value = await page.evaluate(
            "var el = byTestId('clarify-answer-count'); return el === null ? null : el.textContent.trim();",
          );
          return typeof value === "string" && value.length > 0 ? value : null;
        },
        "选中后出现「将写入」提示",
        5_000,
      );
      artifacts.push(await page.screenshot("12-clarify.png"));

      const skipped = await page.tap('[data-testid=clarify-skip]');
      must(skipped.ok === true, `点不到「跳过，直接生成」：${JSON.stringify(skipped)}`);
      // 跳过追问之后是蓝图卡（R-06）：这一步证明"跳过澄清"不会连带跳过蓝图。
      await waitFor(
        async () => (await page.evaluate("return byTestId('plan-card') !== null")),
        "跳过追问后出现蓝图卡片",
        20_000,
      );
      const confirmPlan = await page.tap('[data-testid=plan-confirm]');
      must(confirmPlan.ok === true, `点不到「按蓝图生成」：${JSON.stringify(confirmPlan)}`);
      await waitFor(
        async () => (await page.text()).includes("生成完成"),
        "跳过追问后生成走完（出现「生成完成」）",
        30_000,
      );
      return { slots, answerLine };
    });

    const summary = {
      ok: true,
      chrome,
      ports: { app: apiPort, cdp: debugPort },
      form: { formId: publish.formId, slug: publish.slug, publishMode: publish.mode },
      login,
      generate: { source: generate.source },
      student,
      submitted,
      edited,
      clarify,
      dashboard,
      graded,
      steps,
      artifacts,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    failure = error;
  } finally {
    cdp?.close();
    for (const child of children.reverse()) killTree(child);
    await sleepMs(800);
    if (process.env["KEEP_RUN_DIR"] === "1") {
      process.stdout.write(`[loop] 临时目录已保留：${runDir}\n`);
    } else {
      await removeDirQuietly(runDir);
    }
  }

  if (failure !== null) {
    const reason =
      failure instanceof MissingBrowserError
        ? failure.message
        : failure instanceof Error
          ? (failure.stack ?? failure.message)
          : String(failure);
    process.stderr.write(`[loop] 失败：${reason}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: failure instanceof Error ? failure.message : String(failure), steps, artifacts }, null, 2)}\n`,
    );
    process.exit(failure instanceof MissingBrowserError ? 2 : 1);
  }
}

await main().catch((error) => {
  process.stderr.write(`[loop] 崩溃：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
