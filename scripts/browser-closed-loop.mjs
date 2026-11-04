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

/**
 * 第 10 步（R-09）的问卷需求。
 *
 * 两个刻意的约束：
 * - 带「问卷」二字且点明题量/题型：`inferFormKind` 与蓝图都会判成 survey，
 *   需求本身也过得了澄清（0 条追问）——这一步只验收集页链路，不验澄清；
 * - 题量写「3 道题」：mock 问卷脚本恰好出 3 个字段（2 简答 + 1 量表），
 *   蓝图对照因此能对上，时间线上不会出现"结构与蓝图有偏差"的噪声。
 */
const SURVEY_REQUIREMENT = "做一份课程反馈问卷，3 道题：2 道简答题收集收获与建议、1 道量表题打分，不判分";

/**
 * 第 14 步（A-02「先看蓝图」开关关掉时）用的需求。
 *
 * 槽位写全（场景 / 题量 / 题型 / 分值 / 知识点）：澄清因此 0 追问，关掉开关后
 * 点「生成表单」会直接进入字段流——这一步要证明的就是"不出现蓝图卡"。
 */
const DIRECT_REQUIREMENT = "出一份二次函数随堂测：5 道单选，共 25 分，覆盖顶点坐标";

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
  function setSelectAt(selector, index, value) {
    var el = document.querySelectorAll(selector)[index];
    if (el === undefined) return { ok: false, reason: 'missing ' + selector + '[' + index + ']' };
    var descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
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

  /**
   * 切「媒体类型 / 系统颜色偏好」：打印样式与暗色模式都只能在这里验。
   * `Emulation.setEmulatedMedia` 是 CDP 的正规入口，比改 DOM 类名更接近真实环境。
   */
  async emulateMedia({ media = "", colorScheme = null } = {}) {
    const features = colorScheme === null ? [] : [{ name: "prefers-color-scheme", value: colorScheme }];
    await this.cdp.send("Emulation.setEmulatedMedia", { media, features });
  }

  /** 真出一份 PDF：打印版考卷的证据不是「看起来像」，而是可打开的成品。 */
  async printToPdf(fileName) {
    const pdf = await this.cdp.send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
    });
    const target = join(EVIDENCE_DIR, fileName);
    writeFileSync(target, Buffer.from(pdf.data, "base64"));
    return target;
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

// Collection stats are intentionally read from the survey dashboard rather than score fields.
async function collectionStatRows(page) {
  return page.evaluate(
    "return Array.prototype.map.call(document.querySelectorAll('[data-testid=dash-collection-stat]'), function (tr) { return Array.prototype.map.call(tr.querySelectorAll('td'), function (td) { return td.textContent.trim(); }); });",
  );
}

/** 看板「知识点 × 认知层次」矩阵的行文本（R-07）。 */
async function coverageMatrixRows(page) {
  return page.evaluate(
    "var table = document.querySelector('[data-testid=dash-coverage-matrix]'); return table === null ? [] : Array.prototype.map.call(table.querySelectorAll('tbody tr'), function (tr) { return Array.prototype.map.call(tr.querySelectorAll('th,td'), function (cell) { return cell.textContent.trim(); }); });",
  );
}

/**
 * 覆盖矩阵默认收在 `<details>` 里（2026-11-03 起）：DOM 一直在，但格子不可见，
 * 可信点击会因 0×0 失败。要补题先像真人一样点开摘要。
 */
async function openCoverage(page) {
  const opened = await page.evaluate(
    "var d = byTestId('dash-coverage'); return d !== null && d.open === true;",
  );
  if (opened) return;
  const toggled = await page.tap('[data-testid="dash-coverage-toggle"]');
  must(toggled.ok === true, `点不到覆盖分析展开按钮：${JSON.stringify(toggled)}`);
  await waitFor(
    async () =>
      (await page.evaluate("var d = byTestId('dash-coverage'); return d !== null && d.open === true;")),
    "覆盖分析展开",
    10_000,
  );
}

const steps = [];
const artifacts = [];

/** 证据文件按本次运行的实际产物数连号，不把 01…19 写死在每一行里。 */
function nextArtifactName(kind) {
  return `${String(artifacts.length + 1).padStart(2, "0")}-${kind}.png`;
}

/** 当前草稿版本号（`edit-form-meta` 里的 `v3`），读不到给 null。 */
async function draftVersionOf(page) {
  return page.evaluate(
    "var el = byTestId('edit-form-meta'); if (el === null) return null; var m = el.textContent.match(/v(\\d+)/); return m === null ? null : Number(m[1]);",
  );
}

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

    // 1) 登录：先验证「未登录直接打开看板会被登录页拦住」，再登录回到原地址。
    const login = await step("登录优先：未登录打开 /dashboard 显示登录页，登录后回看板", async () => {
      await page.goto(`${webBase}/dashboard`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('input[name=email]') !== null")),
        "未登录打开看板时应先显示登录表单",
      );
      const gatedPath = await page.path();
      must(gatedPath === "/dashboard", `登录页不应改写地址，实际 ${gatedPath}`);
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
      return { gatedPath, path: await page.path(), forms };
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

      // 知识点 × 题型配额：给立体几何指定 1 道简答 + 1 道单选。
      // 先加一个知识点并改名，再加两条指定；截图会留下这个编辑态。
      const addedPoint = await page.evaluate("return clickButtonByText('^加知识点$')");
      must(addedPoint === true, "点不到「加知识点」");
      const namedPoint = await page.evaluate(
        `return setValue('[aria-label="知识点 1 名称"]', "立体几何");`,
      );
      must(namedPoint.ok === true, `知识点没改名：${JSON.stringify(namedPoint)}`);
      for (const label of ["第 1 条", "第 2 条"]) {
        const added = await page.tap('[data-testid="plan-quota-add"]');
        must(added.ok === true, `点不到「加指定」（${label}）：${JSON.stringify(added)}`);
      }
      const shortSet = await page.evaluate(
        "return setSelectAt('[data-testid=plan-quota-type]', 0, 'short');",
      );
      must(shortSet.ok === true, `第 1 条指定没改成简答：${JSON.stringify(shortSet)}`);
      await waitFor(
        async () =>
          (await page.evaluate(
            "var rows = document.querySelectorAll('[data-testid=plan-quota-type]'); return rows[0] !== undefined && rows[0].value === 'short';",
          )),
        "第 1 条指定保留简答",
        10_000,
      );
      const singleSet = await page.evaluate(
        "return setSelectAt('[data-testid=plan-quota-type]', 1, 'single');",
      );
      must(singleSet.ok === true, `第 2 条指定没改成单选：${JSON.stringify(singleSet)}`);
      const quotaRows = await waitFor(
        async () => {
          const rows = await page.evaluate(`
            return Array.prototype.map.call(document.querySelectorAll('[data-testid=plan-quota]'), function (row) {
              return {
                point: row.querySelector('[data-testid=plan-quota-kp]').selectedOptions[0].textContent.trim(),
                type: row.querySelector('[data-testid=plan-quota-type]').value,
                count: row.querySelector('[data-testid=plan-quota-count]').value,
              };
            });
          `);
          return rows.length === 2 &&
            rows[0].type === "short" &&
            rows[1].type === "single" &&
            rows.every((row) => row.point === "立体几何" && row.count === "1")
            ? rows
            : null;
        },
        "两条配额显示为立体几何的简答 1 + 单选 1",
        10_000,
      );

      // 蓝图不是只读公告：改标题后受控输入必须保留新值，确认按钮仍可用。
      const editedPlanTitle = "教师改过的蓝图标题";
      const planTyped = await page.evaluate(
        `return setValue('[data-testid=plan-title]', ${JSON.stringify(editedPlanTitle)});`,
      );
      must(planTyped.ok === true, `蓝图标题没填进去：${JSON.stringify(planTyped)}`);
      await waitFor(
        async () => {
          const value = await page.evaluate(
            "var el = byTestId('plan-title'); return el === null ? null : el.value;",
          );
          return value === editedPlanTitle ? value : null;
        },
        "蓝图标题改动保留在输入框里",
        10_000,
      );
      // 标题改动触发一次 React 重渲染：若配额题型只改了 DOM、没进 state，
      // 受控 select 会在这时被 state 覆写回原值。这里重读一遍作为真证据。
      const quotaRowsAfterTitle = await page.evaluate(`
        return Array.prototype.map.call(document.querySelectorAll('[data-testid=plan-quota]'), function (row) {
          return {
            point: row.querySelector('[data-testid=plan-quota-kp]').selectedOptions[0].textContent.trim(),
            type: row.querySelector('[data-testid=plan-quota-type]').value,
            count: row.querySelector('[data-testid=plan-quota-count]').value,
          };
        });
      `);
      must(
        quotaRowsAfterTitle.length === 2 &&
          quotaRowsAfterTitle[0].type === "short" &&
          quotaRowsAfterTitle[1].type === "single" &&
          quotaRowsAfterTitle.every((row) => row.point === "立体几何" && row.count === "1"),
        `配额题型没有进入 React 状态（重渲染后丢失）：${JSON.stringify(quotaRowsAfterTitle)}`,
      );
      const planConfirmDisabled = await page.evaluate(
        "var el = byTestId('plan-confirm'); return el === null ? null : el.disabled;",
      );
      must(planConfirmDisabled === false, "改蓝图后确认按钮不应变灰");

      // 题型分布的数字要真的看得清：输入框太窄时数字被裁掉，截图和 DOM 都留证。
      const typeInputs = await page.evaluate(`
        return Array.from(document.querySelectorAll('[aria-label$="数量"]')).map(function (el) {
          var rect = el.getBoundingClientRect();
          return { label: el.getAttribute('aria-label'), width: Math.round(rect.width), font: getComputedStyle(el).fontSize };
        });
      `);
      must(typeInputs.length > 0, "蓝图里没有题型分布输入框");
      must(
        typeInputs.every((entry) => entry.width >= 48 && parseFloat(entry.font) >= 12),
        `题型分布输入框太窄或字号太小：${JSON.stringify(typeInputs)}`,
      );

      // 难度分布（P24）：四档中文输入必须在场，且和等于题型和（同一套配平函数）。
      const difficulty = await page.evaluate(`
        var block = byTestId('plan-difficulty');
        if (block === null) return null;
        var inputs = Array.prototype.slice.call(block.querySelectorAll('input'));
        var typeSum = 0;
        Array.prototype.forEach.call(document.querySelectorAll('[data-testid=plan-card] input'), function (input) {
          var label = input.getAttribute('aria-label') || '';
          if (label.slice(-2) === '数量' && block.contains(input) === false) typeSum += Number(input.value || 0);
        });
        return {
          labels: inputs.map(function (input) { return input.getAttribute('aria-label'); }),
          values: inputs.map(function (input) { return Number(input.value || 0); }),
          widths: inputs.map(function (input) { return Math.round(input.getBoundingClientRect().width); }),
          fonts: inputs.map(function (input) { return getComputedStyle(input).fontSize; }),
          typeSum: typeSum
        };
      `);
      must(difficulty !== null, "蓝图里没有难度分布");
      const difficultySum = difficulty.values.reduce((sum, value) => sum + value, 0);
      must(
        difficulty.labels.length === 4 &&
          ["基础", "提升", "综合", "压轴"].every((label) => difficulty.labels.includes(`${label}难度数量`)),
        `难度分布不是四档中文输入：${JSON.stringify(difficulty.labels)}`,
      );
      must(
        difficultySum === difficulty.typeSum,
        `难度和 ${String(difficultySum)} 与题型和 ${String(difficulty.typeSum)} 不一致`,
      );
      must(
        difficulty.widths.every((width) => width >= 48) &&
          difficulty.fonts.every((font) => parseFloat(font) >= 12),
        `难度输入框太窄或字号太小：${JSON.stringify(difficulty)}`,
      );

      // 知识点行不该把内部 id 当输入内容；id 仍留在蓝图里给题目引用。
      const planInputValues = await page.evaluate(
        "return Array.from(document.querySelectorAll('[data-testid=plan-card] input')).map(function (el) { return el.value; });",
      );
      must(
        planInputValues.every((value) => !value.startsWith("kp_")),
        `蓝图输入框暴露了知识点内部 id：${JSON.stringify(planInputValues)}`,
      );

      // 截图对准蓝图卡（左栏此刻已滚动），而不是只拍页面顶部。
      await page.evaluate("var el = byTestId('plan-card'); if (el !== null) el.scrollIntoView({ block: 'start' });");
      artifacts.push(await page.screenshot("02b-plan.png"));
      // 截图之后清理演示用的知识点；删除知识点应连带删掉它的两条配额。
      const removedPoint = await page.tap('[aria-label="删除知识点 1"]');
      must(removedPoint.ok === true, `点不到「删除知识点」：${JSON.stringify(removedPoint)}`);
      await waitFor(
        async () =>
          (await page.evaluate(
            "return document.querySelectorAll('[data-testid=plan-quota]').length === 0;",
          )),
        "删除知识点后配额行一并消失",
        10_000,
      );
      const confirmPlan = await page.tap('[data-testid=plan-confirm]');
      must(confirmPlan.ok === true, `点不到「按蓝图生成」：${JSON.stringify(confirmPlan)}`);
      // mock 是内置脚本 + 一条故意写坏再修复的题：等前端把 done 状态渲染出来。
      await waitFor(async () => (await page.text()).includes("生成完成"), "生成流走完（出现「生成完成」）", 30_000);
      // 截图前把页面与左栏都滚回顶部：上面为了拍蓝图卡滚过，不归位会少拍需求与生成方式。
      const leftLayout = await page.evaluate(`
        window.scrollTo(0, 0);
        var section = document.querySelector('[aria-label="需求输入"]');
        if (section === null) return null;
        section.scrollTop = 0;
        var children = Array.prototype.slice.call(section.children);
        var childrenHeight = children.reduce(function (sum, el) {
          return sum + el.getBoundingClientRect().height;
        }, 0);
        return {
          sectionHeight: Math.round(section.getBoundingClientRect().height),
          childrenHeight: Math.round(childrenHeight),
          blankGap: Math.round(section.getBoundingClientRect().height - childrenHeight),
        };
      `);
      must(leftLayout !== null, "找不到左栏");
      // 左栏必须按内容收口：mt-auto/flex-1 曾把它拉到和预览栏一样高，按钮上方留出整屏空白。
      must(
        leftLayout.blankGap >= -4 && leftLayout.blankGap <= 4,
        `左栏出现异常空白：${JSON.stringify(leftLayout)}`,
      );
      artifacts.push(await page.screenshot("02-generate.png"));
      const source = await page.evaluate(
        "var el = byTestId('data-source'); return el === null ? '' : el.textContent.trim();",
      );
      const timeline = await page.text();
      must(timeline.includes("修复") || timeline.includes("repair"), "时间线里没有修复记录（mock 必然有一次）");
      // R-06 的界面级证据：时间线里必须真的出现 plan 阶段与蓝图摘要。
      must(timeline.includes("蓝图已确认"), "时间线里没有蓝图摘要（plan 阶段没发生）");

      // 发布前直接改题：点「编辑这题」→ 改题干 → 预览卡立即显示新文案。
      const editButton = await page.evaluate(
        `var el = document.querySelector('[data-testid^="preview-edit-"]'); return el === null ? null : el.getAttribute('data-testid');`,
      );
      must(editButton !== null, "预览卡没有「编辑这题」入口");
      const editedItemId = editButton.slice("preview-edit-".length);
      const opened = await page.tap(`[data-testid="${editButton}"]`);
      must(opened.ok === true, `点不到「编辑这题」：${JSON.stringify(opened)}`);
      await waitFor(
        async () =>
          (await page.evaluate(
            `return byTestId(${JSON.stringify(`preview-editor-${editedItemId}`)}) !== null;`,
          )),
        "预览卡进入编辑态",
        10_000,
      );
      const editedTitle = "就地改过的第一题";
      const titleTyped = await page.evaluate(
        `return setValue('[data-testid=${JSON.stringify(`preview-title-${editedItemId}`)}]', ${JSON.stringify(editedTitle)});`,
      );
      must(titleTyped.ok === true, `预览题干没填进去：${JSON.stringify(titleTyped)}`);
      await waitFor(
        async () => {
          const value = await page.evaluate(
            `var el = byTestId(${JSON.stringify(`preview-title-${editedItemId}`)}); return el === null ? null : el.value;`,
          );
          return value === editedTitle ? value : null;
        },
        "预览编辑保留新题干",
        10_000,
      );
      const closed = await page.tap(`[data-testid="${editButton}"]`);
      must(closed.ok === true, `点不到「收起编辑」：${JSON.stringify(closed)}`);
      await waitFor(
        async () => (await page.text()).includes(editedTitle),
        "收起编辑后预览卡显示改过的题干",
        10_000,
      );

      // 单选答案行必须渲染公式：把选项改成 LaTeX，收起编辑后答案里应是 KaTeX，
      // 不是 `答案：b（$2x-1=7$）` 这种原样美元符。
      const mathEdit = await page.tap('[data-testid="preview-edit-q_single"]');
      must(mathEdit.ok === true, `点不到第 2 题的「编辑这题」：${JSON.stringify(mathEdit)}`);
      await waitFor(
        async () =>
          (await page.evaluate("return byTestId('preview-editor-q_single') !== null")),
        "第 2 题进入预览编辑态",
        10_000,
      );
      const mathTyped = await page.evaluate(
        `return setValue('[data-testid="preview-editor-q_single"] [aria-label="选项 2"]', "$2x-1=7$");`,
      );
      must(mathTyped.ok === true, `选项没改成公式：${JSON.stringify(mathTyped)}`);
      const mathClosed = await page.tap('[data-testid="preview-edit-q_single"]');
      must(mathClosed.ok === true, `点不到第 2 题的「收起编辑」：${JSON.stringify(mathClosed)}`);
      const answerLine = await waitFor(
        async () => {
          const found = await page.evaluate(`
            var field = document.querySelector('#field-q_single');
            if (field === null) return null;
            var text = field.textContent || '';
            if (text.indexOf('答案：') < 0 || text.indexOf('$2x-1=7$') >= 0) return null;
            return { hasKatex: field.querySelector('.katex') !== null, text: text.slice(0, 80) };
          `);
          return found !== null && found.hasKatex ? found : null;
        },
        "单选答案行出现 KaTeX 且不再显示原始 $...$",
        10_000,
      );
      must(answerLine.hasKatex === true, `答案行没有 KaTeX：${JSON.stringify(answerLine)}`);

      // 接着把选项改回纯文本，避免这次渲染验证污染后面发布/学生页的测试数据。
      const restoreEdit = await page.tap('[data-testid="preview-edit-q_single"]');
      must(restoreEdit.ok === true, `点不到第 2 题（还原选项）：${JSON.stringify(restoreEdit)}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('preview-editor-q_single') !== null")),
        "第 2 题再次进入预览编辑态",
        10_000,
      );
      const restored = await page.evaluate(
        `return setValue('[data-testid="preview-editor-q_single"] [aria-label="选项 2"]', "4");`,
      );
      must(restored.ok === true, `选项没还原成纯文本：${JSON.stringify(restored)}`);
      const restoreClosed = await page.tap('[data-testid="preview-edit-q_single"]');
      must(restoreClosed.ok === true, `点不到第 2 题（还原后收起）：${JSON.stringify(restoreClosed)}`);
      await waitFor(
        async () =>
          (await page.evaluate(`
            var field = document.querySelector('#field-q_single');
            if (field === null) return null;
            var lines = Array.prototype.slice.call(field.querySelectorAll('p'));
            var answer = lines.find(function (p) { return (p.textContent || '').indexOf('答案：') === 0; });
            return answer !== undefined && (answer.textContent || '').indexOf('b（4）') >= 0 ? true : null;
          `)),
        "还原后单选答案行显示纯文本 b（4）",
        10_000,
      );
      return {
        requirement: REQUIREMENT,
        source,
        planSummary,
        planTitleEdited: editedPlanTitle,
        quotaRows,
        editedItemId,
        editedTitle,
        answerMath: answerLine.text,
        leftLayout,
        sawRepairEntry: true,
      };
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

        // 生成页里就地改过的题干必须真的进发布快照——这就是「发布界面能直接改题」的证据。
        const detail = await request("GET", `/api/forms/${formId}`, { cookie });
        must(detail.status === 200, `读已发布表单失败（${String(detail.status)}）：${detail.text}`);
        const editedItem = (detail.json.schema.items ?? []).find(
          (item) => item.id === generate.editedItemId,
        );
        must(editedItem !== undefined, `发布快照里找不到就地编辑的题 ${generate.editedItemId}`);
        must(
          editedItem.title === generate.editedTitle,
          `发布快照没有带上改过的题干：${JSON.stringify(editedItem.title)}`,
        );
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
      const emptyStats = await waitFor(
        async () => {
          const rows = await itemStatRows(page);
          return rows.length > 0 ? rows : null;
        },
        "看板出现「每题正确率」区块",
        10_000,
      );
      must(
        emptyStats.every((cells) => cells[3] === "—"),
        `零提交时正确率应显示 —（不是 0%），实际 ${JSON.stringify(emptyStats)}`,
      );
      const emptyCoverage = await waitFor(
        async () => {
          const rows = await coverageMatrixRows(page);
          return rows.length > 0 ? rows : null;
        },
        "看板出现「知识点 × 布鲁姆覆盖」区块",
        10_000,
      );
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

      // 批改面板必须紧跟在被点的那一行下面，而不是跳整张表的末尾。
      const placement = await page.evaluate(`
        var button = document.querySelector('[data-testid^="dash-grade-"]');
        var row = button === null ? null : button.closest('tr');
        var next = row === null ? null : row.nextElementSibling;
        return {
          rowTag: row === null ? null : row.tagName,
          nextTag: next === null ? null : next.tagName,
          adjacent: next !== null && next.querySelector('[data-testid="grade-panel"]') !== null,
        };
      `);
      must(
        placement.adjacent === true,
        `批改面板不在所点行下面：${JSON.stringify(placement)}`,
      );

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
    const edited = await step("编辑器里用一句话改一版，撤销再重做", async () => {
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

      // 重做：撤销后服务端栈里有一步，按钮应可点；点完版本回到 v2。
      const redo = await page.tap('[data-testid="edit-redo"]');
      must(redo.ok === true, `点不到「重做」：${JSON.stringify(redo)}`);
      await waitFor(
        async () => (await page.evaluate("var el = byTestId('edit-form-meta'); return el !== null && el.textContent.indexOf('v2') >= 0;")),
        "重做后回到 v2",
        20_000,
      );
      const redoNotice = await page.evaluate(
        "var el = byTestId('edit-notice'); return el === null ? '' : el.textContent.trim();",
      );
      return { before, proposal: proposal.slice(0, 80), notice, redoNotice };
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

    // 10) 收集页闭环（省赛 R-09）：生成问卷 → 发布 → 手机填写 → 回收看板 → CSV
    //
    // 与第 2 步的分工：第 2 步证明"测验"能生成判分；这一步证明"问卷"能从同一个
    // 生成页点出来（选问卷 → 蓝图 → mock 问卷脚本 → 发布），再走完收集页闭环。
    // 三处口径在这里被断死：①问卷字段不带答案/分值；②成功卡片与看板都不出现分数
    // （0.2 #5 的 `0/0` 与"均分 0"）；③CSV 能导出回收的答案。
    const surveyCollection = await step("收集页闭环：生成问卷 → 填写 → 回收看板与 CSV", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('#requirement-input') !== null")),
        "生成页需求输入框渲染",
      );
      const pickedKind = await page.evaluate("return clickButtonByText('^问卷$');");
      must(pickedKind === true, "没找到「问卷」类型按钮");
      const typed = await page.evaluate(
        `return setValue('#requirement-input', ${JSON.stringify(SURVEY_REQUIREMENT)});`,
      );
      must(typed.ok === true, `问卷需求没填进去：${JSON.stringify(typed)}`);
      must(await page.evaluate("return clickButtonByText('^生成表单$')"), "没找到「生成表单」按钮");

      await waitFor(
        async () => (await page.evaluate("return byTestId('plan-card') !== null")),
        "问卷蓝图卡片出现",
        20_000,
      );
      const planText = await page.evaluate(
        "var el = byTestId('plan-card'); return el === null ? '' : el.textContent;",
      );
      must(planText.includes("问卷"), `蓝图卡没有把表单类型标成问卷：${planText.slice(0, 120)}`);
      const confirmPlan = await page.tap('[data-testid=plan-confirm]');
      must(confirmPlan.ok === true, `点不到「按蓝图生成」：${JSON.stringify(confirmPlan)}`);
      await waitFor(
        async () => (await page.text()).includes("生成完成"),
        "问卷生成走完（出现「生成完成」）",
        30_000,
      );
      // kind 真的传到了生成链路：时间线上一句「判定为 问卷」来自服务端，不是前端写死的。
      const generatedText = await page.text();
      must(generatedText.includes("判定为 问卷"), "时间线没有把表单判成问卷（kind 没有传到生成链路）");
      artifacts.push(await page.screenshot("13-survey-generated.png"));

      // 发布：UI 上的「发布」按钮（与第 3 步同一入口）。
      must(
        await page.evaluate("return buttonLabels().some(function (t) { return /发布/.test(t); })"),
        "问卷生成后没有发布按钮",
      );
      await page.evaluate("return clickButtonByText('发布')");
      await waitFor(
        async () => /\/f\/[a-z0-9]+/.test(await page.text()),
        "问卷发布后页面出现学生短链",
        12_000,
      );
      const slug = /\/f\/([a-z0-9]+)/.exec(await page.text())?.[1] ?? "";
      must(slug !== "", "问卷发布成功但页面里没抓到 slug");
      const list = await request("GET", "/api/forms", { cookie });
      must(list.status === 200, `读取表单列表失败（${String(list.status)}）`);
      const surveyForm = (list.json.forms ?? []).find((form) => form.slug === slug);
      must(surveyForm !== undefined && surveyForm.kind === "survey", `发布出来的不是问卷：${JSON.stringify(surveyForm)}`);

      // 学生端：手机视口填写。问卷字段没有答案/分值，ui 上没有"对错"。
      await page.viewport(MOBILE_VIEWPORT);
      await page.goto(`${webBase}/f/${slug}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('fill-submit') !== null")),
        "survey 收集页渲染提交按钮",
        20_000,
      );
      const surveyDetail = await request("GET", `/api/forms/${surveyForm.id}`, { cookie });
      must(surveyDetail.status === 200, `读取 survey 详情失败（${String(surveyDetail.status)}）`);
      const surveyItems = surveyDetail.json.schema.items;
      must(
        surveyItems.every((item) => item.answer === undefined && item.score === undefined),
        `问卷字段不应带答案或分值：${JSON.stringify(surveyItems)}`,
      );
      for (const item of surveyItems) {
        if (item.type === "section") continue;
        if (item.type === "scale") {
          const hit = await page.tap(`[data-testid="fill-${item.id}-4"]`);
          must(hit.ok === true, `点不到 survey 量表 ${item.id}：${JSON.stringify(hit)}`);
        } else if (item.required === true) {
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', "浏览器闭环 survey 填写");`,
          );
          must(filled.ok === true, `survey 字段 ${item.id} 没填进去：${JSON.stringify(filled)}`);
        }
      }
      artifacts.push(await page.screenshot("14-survey-student.png"));
      const submitted = await page.tap('[data-testid="fill-submit"]');
      must(submitted.ok === true, "点不到 survey 提交按钮");
      await waitFor(async () => (await page.text()).includes("答案已记录"), "survey 提交成功卡片", 20_000);
      const successText = await page.text();
      // 问卷不判分：成功卡片只有「已提交」，不许出现「得分 / 满分」。
      must(!/\d+\s*\/\s*\d+/.test(successText), `survey 成功卡片不应出现分数：${successText.slice(0, 160)}`);

      // 教师看板：回收情况 + 提交记录（无分数列）+ CSV。
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/dashboard/${surveyForm.id}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('dash-collection-stats') !== null")),
        "survey 回收看板出现逐字段统计",
        20_000,
      );
      const collectionRows = await collectionStatRows(page);
      must(collectionRows.length > 0, "survey 看板没有逐字段回收统计");
      // 各选项分布（A-09）：量表 1–5 应有 5 档，选中的 4 档计数为 1、占比 100%。
      const optionRows = await page.evaluate(
        "return Array.prototype.map.call(document.querySelectorAll('[data-testid=dash-collection-option]'), function (el) { var spans = el.querySelectorAll('span'); return { label: (spans[0] || {}).textContent || '', count: (spans[1] || {}).textContent || '', rate: (spans[2] || {}).textContent || '' }; });",
      );
      must(optionRows.length >= 5, `survey 看板应给出量表的各档分布，实际 ${JSON.stringify(optionRows)}`);
      const chosen = optionRows.find((row) => row.label.trim() === "4");
      must(
        chosen !== undefined && chosen.count.trim() === "1" && chosen.rate.includes("100%"),
        `量表第 4 档的分布应为 1（100%），实际 ${JSON.stringify(chosen)}`,
      );
      const dashboardText = await page.text();
      must(!dashboardText.includes("平均分"), "survey 看板不应出现「平均分」");
      must(!dashboardText.includes("满分"), "survey 看板不应出现「满分」");
      must(
        !/\b0\s*\/\s*0\b/.test(dashboardText),
        `survey 看板不应出现 0/0。页面文本片段：${dashboardText.replace(/\s+/g, " ").slice(0, 400)}`,
      );
      must(!/每题正确率/.test(dashboardText), "survey 看板不应出现每题正确率");
      must(dashboardText.includes("回收记录"), "survey 看板没有「回收记录」标题");
      // CSV 入口在页面上；内容用同一份会话从接口取（headless 下载不便断言）。
      must(await page.evaluate("return byTestId('dash-csv') !== null"), "survey 看板没有 CSV 入口");
      const csv = await request("GET", `/api/forms/${surveyForm.id}/submissions.csv`, { cookie });
      must(csv.status === 200, `survey CSV 导出失败（${String(csv.status)}）`);
      must(csv.text.includes("s_feedback"), `survey CSV 缺少回收字段列：${csv.text.slice(0, 200)}`);
      must(csv.text.includes("浏览器闭环 survey 填写"), "survey CSV 里没有刚提交的答案");
      artifacts.push(await page.screenshot("15-survey-dashboard.png"));
      return { formId: surveyForm.id, slug, collectionRows, csvLines: csv.text.split("\r\n").length };
    });

    // 11) 打印版考卷（省赛附加 A-17）：卷面 + 含答案开关 + 打印媒体
    //
    // 三条断言各自防一种「看着像打印版」的假实现：题号要只数题目（分节不占号）；
    // 答案默认不出现、勾选后才出现（不是靠 CSS 藏）；打印媒体下界面外壳真的消失。
    // 最后用 `Page.printToPDF` 落一份 PDF——纸上能不能用，打开它就知道。
    const printed = await step("打印版考卷：卷面、含答案开关与打印媒体", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/forms/${publish.formId}/print`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('print-sheet') !== null")),
        "打印页渲染出卷面",
        20_000,
      );
      const plainText = await page.evaluate("return byTestId('print-sheet').innerText");
      must(/1\./.test(plainText), `打印页没有题号：${plainText.slice(0, 120)}`);
      must(!plainText.includes("答案："), `打印页默认不应出现答案：${plainText.slice(0, 200)}`);
      must(!plainText.includes("解析："), "打印页默认不应出现解析");

      const toggled = await page.tap('[data-testid="print-with-answers"]');
      must(toggled.ok === true, `点不到「含答案与解析」：${JSON.stringify(toggled)}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('print-sheet').innerText")).includes("答案："),
        "勾选后卷面出现答案",
        5_000,
      );

      await page.emulateMedia({ media: "print" });
      const toolbarDisplay = await page.evaluate(
        "var el = document.querySelector('.no-print'); return el === null ? 'missing' : getComputedStyle(el).display;",
      );
      must(toolbarDisplay === "none", `打印媒体下界面外壳应隐藏，实际 display=${String(toolbarDisplay)}`);
      artifacts.push(await page.screenshot("16-print-preview.png"));
      const pdf = await page.printToPdf("16-print-sheet.pdf");
      // PDF 也算产物：它是"打印版真的印得出来"的唯一可打开证据。
      artifacts.push(pdf);
      await page.emulateMedia({});
      return { pdf, questionCount: (plainText.match(/\n\d+\./g) ?? []).length };
    });

    // 12) 提交后答案解析（省赛附加 A-18）：
    // 教师在看板上打开开关 → 学生重新提交 → 成功页出现「答案解析」。
    //
    // 这一步证明的是**开关真的改变了学生端收到的东西**；VC12 证明的是接口语义。
    const answerReview = await step("答案解析：教师开启 → 学生重交 → 看到答案与解析", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/dashboard/${publish.formId}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('dash-show-answers') !== null")),
        "看板出现「提交后展示答案解析」开关",
        20_000,
      );
      const toggle = await page.tap('[data-testid="dash-show-answers"]');
      must(toggle.ok === true, `点不到答案解析开关：${JSON.stringify(toggle)}`);
      await waitFor(
        async () => (await page.text()).includes("（已开启）"),
        "开关变为已开启",
        10_000,
      );

      // 学生重新答一遍：这次要全对，好让「正确」出现（简答仍然是待批改）。
      await page.viewport(MOBILE_VIEWPORT);
      await page.goto(`${webBase}/f/${publish.slug}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('fill-submit') !== null")),
        "学生页渲染",
        20_000,
      );
      const detail = await request("GET", `/api/forms/${publish.formId}`, { cookie });
      must(detail.status === 200, `读取表单详情失败（${String(detail.status)}）`);
      const items = detail.json.schema.items.filter((item) => item.type !== "section");
      let answered = 0;
      for (const item of items) {
        if (item.type === "single" && typeof item.answer === "string") {
          const hit = await page.tap(`[data-testid="fill-${item.id}-${item.answer}"]`);
          must(hit.ok === true, `点不到单选 ${item.id}`);
          answered += 1;
        } else if (item.type === "multi" && Array.isArray(item.answer)) {
          for (const optionId of item.answer) {
            const hit = await page.tap(`[data-testid="fill-${item.id}-${optionId}"]`);
            must(hit.ok === true, `点不到多选 ${item.id}/${optionId}`);
          }
          answered += 1;
        } else if (item.type === "number" && item.answer !== undefined) {
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', ${JSON.stringify(String(item.answer.value))});`,
          );
          must(filled.ok === true, `数字题 ${item.id} 没填进去`);
          answered += 1;
        } else if (item.type === "fill" && Array.isArray(item.answer)) {
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', ${JSON.stringify(item.answer.join("／"))});`,
          );
          must(filled.ok === true, `填空题 ${item.id} 没填进去`);
          answered += 1;
        } else if (item.type === "short") {
          const filled = await page.evaluate(
            `return setValue('[data-testid="fill-${item.id}"]', "答案解析演示作答");`,
          );
          must(filled.ok === true, `简答题 ${item.id} 没填进去`);
          answered += 1;
        }
      }
      must(answered > 0, "没有可作答的字段");

      const submitted = await page.tap('[data-testid="fill-submit"]');
      must(submitted.ok === true, "点不到提交按钮");
      await waitFor(async () => (await page.text()).includes("答案解析"), "成功页出现答案解析", 20_000);
      const reviewText = await page.text();
      must(reviewText.includes("正确答案："), "答案解析里没有「正确答案」");
      must(reviewText.includes("解析："), "答案解析里没有「解析」");
      must(reviewText.includes("正确"), "全对答卷应至少有一题显示「正确」");
      must(reviewText.includes("待老师批改"), "简答应显示「待老师批改」而不是错误");
      artifacts.push(await page.screenshot("17-answer-review.png"));
      return { reviewed: true };
    });

    // 13) 暗色模式（省赛附加 A-19）：
    // 系统深色 → 自动深色；点开关 → 浅色 → 深色 → 回到跟随系统。
    const darkMode = await step("暗色模式：跟随系统 → 浅色 → 深色", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`${webBase}/dashboard/${publish.formId}`);
      const themeOf = async () => page.evaluate("return document.documentElement.dataset.theme ?? ''");
      await waitFor(async () => (await themeOf()) === "dark", "系统深色时自动进入深色", 10_000);
      const darkBg = await page.evaluate("return getComputedStyle(document.body).backgroundColor");
      must(darkBg === "rgb(20, 19, 15)", `深色底色不对：${String(darkBg)}`);
      artifacts.push(await page.screenshot("18-dark-dashboard.png"));

      const first = await page.tap('[data-testid="theme-toggle"]');
      must(first.ok === true, `点不到主题开关：${JSON.stringify(first)}`);
      await waitFor(async () => (await themeOf()) === "light", "手动切到浅色", 10_000);
      const lightBg = await page.evaluate("return getComputedStyle(document.body).backgroundColor");
      must(lightBg === "rgb(247, 247, 245)", `浅色底色不对：${String(lightBg)}`);

      await page.tap('[data-testid="theme-toggle"]');
      await waitFor(async () => (await themeOf()) === "dark", "再切到深色", 10_000);
      await page.tap('[data-testid="theme-toggle"]');
      // 第三次点回「跟随系统」：系统仍是深色，所以解析结果仍是深色——
      // 这里断的是偏好本身，而不是颜色，才能区分"跟随系统"与"手动深色"。
      await waitFor(
        async () =>
          (await page.evaluate("return byTestId('theme-toggle').getAttribute('data-theme-preference')")) ===
          "system",
        "第三次点回到跟随系统",
        10_000,
      );
      await page.emulateMedia({});
      return { darkBg, lightBg };
    });

    // 14) 跳过蓝图直生成（A-02 的「先看蓝图」开关）：
    // 关掉开关后点「生成表单」应**直接出字段流**，不出现蓝图卡、时间线也不演 plan。
    const directGenerate = await step("跳过蓝图直生成：关掉开关后不出现蓝图卡", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('#requirement-input') !== null")),
        "生成页需求输入框渲染",
      );
      const initial = await page.evaluate(
        "var el = byTestId('plan-first'); return el === null ? null : el.checked;",
      );
      must(initial === true, `「先看蓝图再生成」默认应为开，实际 ${JSON.stringify(initial)}`);

      const toggled = await page.tap('[data-testid="plan-first"]');
      must(toggled.ok === true, `点不到「先看蓝图」开关：${JSON.stringify(toggled)}`);
      const off = await page.evaluate("var el = byTestId('plan-first'); return el === null ? null : el.checked;");
      must(off === false, `开关没有关掉：${JSON.stringify(off)}`);

      const typed = await page.evaluate(
        `return setValue('#requirement-input', ${JSON.stringify(DIRECT_REQUIREMENT)});`,
      );
      must(typed.ok === true, `需求没填进去：${JSON.stringify(typed)}`);
      must(await page.evaluate("return clickButtonByText('^生成表单$')"), "没找到「生成表单」按钮");

      await waitFor(async () => (await page.text()).includes("生成完成"), "跳过蓝图后直接生成走完", 30_000);
      const text = await page.text();
      must(
        (await page.evaluate("return byTestId('plan-card')")) === null,
        "关掉「先看蓝图」后不应出现蓝图卡",
      );
      must(!text.includes("蓝图已确认"), "关掉「先看蓝图」后时间线不应出现蓝图确认（未发生不许演出）");
      // 注意用带冒号的那一句：开关的说明文字里也写着「不会出现蓝图对照」，
      // 只搜四个字会把说明文案误当成事件。
      must(!text.includes("蓝图对照："), "关掉「先看蓝图」后不应出现蓝图对照事件");
      artifacts.push(await page.screenshot("19-skip-plan.png"));
      return { planFirst: false, sawPlanCard: false };
    });

    // 15) 单题编辑（A-20 / P18）：
    // 手改第 2 题的正确项 → diff 出现「第 2 题 · 答案」→ 保存 → 其它题字节不变；
    // 再用右侧的「只改这道题」输入条跑一次建议，卡片标题写明「仅第 2 题」，采用后
    // 其余题仍不变。答案改动的判分口径由 VC13 负责，这里只验"教师点得到、看得见"。
    const singleItem = await step("单题编辑：改正确项看 diff，再只改这题跑建议", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/forms/${publish.formId}/edit`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-save') !== null")),
        "编辑器渲染出保存按钮",
        20_000,
      );

      // 左侧列表第 2 项 = Schema 下标 1（第 1 项是分节）。
      const target = await page.evaluate(`
        var list = document.querySelectorAll('section[aria-label="题目列表"] button[data-testid^="edit-item-"]');
        if (list.length < 3) return { count: list.length };
        var btn = list[1];
        btn.setAttribute('data-loop-target', '1');
        var testid = btn.getAttribute('data-testid') || '';
        return { count: list.length, testid: testid, text: (btn.textContent || '').trim(), name: btn.textContent || '' };
      `);
      must(target.count >= 3, `题目列表应至少 3 项，实际 ${String(target.count)}`);
      const itemId = target.testid.slice("edit-item-".length);
      must(itemId.length > 0, `取不到第 2 题的 id：${JSON.stringify(target)}`);

      const selected = await page.tap('[data-loop-target="1"]');
      must(selected.ok === true, `点不到第 2 题：${JSON.stringify(selected)}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-item-editor') !== null")),
        "单题面板渲染",
        10_000,
      );
      await waitFor(
        async () => (await page.evaluate("return document.querySelectorAll('[data-testid$=\\\"-correct\\\"]').length > 1")),
        "选项编辑器渲染出正确项勾选",
        10_000,
      );
      artifacts.push(await page.screenshot(nextArtifactName("item-editor")));

      const fetchDetail = `return fetch(${JSON.stringify(`/api/forms/${publish.formId}`)}, { credentials: 'include' }).then(function (r) { return r.json(); });`;
      const before = await page.evaluate(fetchDetail);
      const targetIndex = before.schema.items.findIndex((item) => item.id === itemId);
      must(targetIndex === 1, `第 2 题的 Schema 下标应为 1，实际 ${String(targetIndex)}`);
      must(Array.isArray(before.schema.items[targetIndex].options), "第 2 题应当是选择题");

      const radios = await page.evaluate(`
        var inputs = document.querySelectorAll('[data-testid$="-correct"]');
        var checked = -1;
        for (var i = 0; i < inputs.length; i += 1) if (inputs[i].checked) checked = i;
        return { count: inputs.length, checked: checked };
      `);
      must(radios.count >= 2, `第 2 题应至少 2 个选项，实际 ${String(radios.count)}`);
      const nextIndex = radios.checked === 0 ? 1 : 0;
      const flipped = await page.tap(`[data-testid="edit-option-${String(nextIndex)}-correct"]`);
      must(flipped.ok === true, `点不到正确项：${JSON.stringify(flipped)}`);

      const expectedWhere = `第 ${String(targetIndex + 1)} 题 · 答案`;
      const diffText = await waitFor(
        async () => {
          const text = await page.evaluate(
            "var el = byTestId('edit-changes'); return el === null ? '' : el.textContent.trim();",
          );
          return text.includes(expectedWhere) ? text : null;
        },
        "diff 出现答案改动",
        10_000,
      );
      artifacts.push(await page.screenshot(nextArtifactName("item-diff")));

      const versionBeforeSave = await draftVersionOf(page);
      must(typeof versionBeforeSave === "number", "读不到保存前的草稿版本号");
      const saved = await page.tap('[data-testid="edit-save"]');
      must(saved.ok === true, `点不到保存：${JSON.stringify(saved)}`);
      const versionAfterSave = await waitFor(
        async () => {
          const n = await draftVersionOf(page);
          return typeof n === "number" && n !== versionBeforeSave ? n : null;
        },
        "保存后版本号变化",
        20_000,
      );

      const afterSave = await page.evaluate(fetchDetail);
      for (const [index, item] of before.schema.items.entries()) {
        if (index === targetIndex) continue;
        must(
          JSON.stringify(afterSave.schema.items[index]) === JSON.stringify(item),
          `手改答案后第 ${String(index + 1)} 题被改动了`,
        );
      }
      const patchedItem = afterSave.schema.items[targetIndex];
      must(
        patchedItem.answer === patchedItem.options[nextIndex].id,
        `第 2 题答案应改成第 ${String(nextIndex + 1)} 个选项，实际 ${JSON.stringify(patchedItem.answer)}`,
      );

      // 单题建议条在右侧面板顶部（与页头的整表建议条是两条，测试 id 前缀不同）。
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-item-suggest-input') !== null")),
        "单题建议输入条渲染",
        10_000,
      );
      const typed = await page.evaluate(
        "return setValue('[data-testid=\"edit-item-suggest-input\"]', '把这题的解析写清楚一点');",
      );
      must(typed.ok === true, `单题建议输入框没写进去：${JSON.stringify(typed)}`);
      const asked = await page.tap('[data-testid="edit-item-suggest-run"]');
      must(asked.ok === true, `点不到单题「生成改动建议」：${JSON.stringify(asked)}`);

      const proposal = await waitFor(
        async () => {
          const value = await page.evaluate(`
            var title = byTestId('edit-item-suggest-scope-title');
            var changes = byTestId('edit-item-suggest-changes');
            if (title === null || changes === null) return null;
            return { title: title.textContent.trim(), changes: changes.textContent.trim() };
          `);
          return value !== null && value.changes.length > 0 ? value : null;
        },
        "单题建议卡片列出改动",
        20_000,
      );
      must(proposal.title.startsWith("仅第 2 题"), `单题卡片标题应写明「仅第 2 题」，实际「${proposal.title}」`);
      artifacts.push(await page.screenshot(nextArtifactName("item-suggest")));

      const versionBeforeAdopt = await draftVersionOf(page);
      const adopted = await page.tap('[data-testid="edit-item-suggest-adopt"]');
      must(adopted.ok === true, `点不到单题建议「采用」：${JSON.stringify(adopted)}`);
      await waitFor(
        async () => {
          const n = await draftVersionOf(page);
          return typeof n === "number" && n !== versionBeforeAdopt ? n : null;
        },
        "采用单题建议后版本号变化",
        20_000,
      );

      const afterAdopt = await page.evaluate(fetchDetail);
      for (const [index, item] of afterSave.schema.items.entries()) {
        if (index === targetIndex) continue;
        must(
          JSON.stringify(afterAdopt.schema.items[index]) === JSON.stringify(item),
          `单题建议采用后第 ${String(index + 1)} 题被改动了`,
        );
      }
      const stillSelected = await page.evaluate(
        "var el = document.querySelector('section[aria-label=\\\"题目列表\\\"] button[aria-current=\\\"true\\\"]'); return el === null ? null : el.getAttribute('data-testid');",
      );
      must(stillSelected === `edit-item-${itemId}`, `采用建议后应仍选中第 2 题，实际 ${JSON.stringify(stillSelected)}`);

      return {
        itemId,
        targetIndex,
        changedOption: nextIndex,
        diff: diffText.slice(0, 80),
        proposal: proposal.title,
        versions: { before: versionBeforeSave, afterSave: versionAfterSave },
      };
    });

    // 16) 覆盖矩阵点击补题（2026-11-03）：
    // 点矩阵格 → 编辑页出现「补题」面板 → 模型生成候选题 → 加入草稿并保存；
    // 再从矩阵点另一格走手动路径，确认模板题带上了知识点与层级。
    const supplement = await step("覆盖矩阵点击补题：模型生成 + 手动模板", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/dashboard/${publish.formId}`);
      await waitFor(
        async () =>
          (await page.evaluate("return document.querySelectorAll('[data-testid^=\"coverage-cell-\"]').length > 1")),
        "覆盖矩阵渲染出可点击单元格",
        20_000,
      );
      await openCoverage(page);
      const cell = await page.evaluate(`
        var el = document.querySelector('[data-testid^="coverage-cell-"]');
        if (el === null) return null;
        return { testid: el.getAttribute('data-testid'), label: el.getAttribute('aria-label') };
      `);
      must(cell !== null && cell.testid !== null, `取不到覆盖矩阵单元格：${JSON.stringify(cell)}`);
      const prefix = "coverage-cell-";
      const rest = cell.testid.slice(prefix.length);
      const lastDash = rest.lastIndexOf("-");
      must(lastDash > 0, `单元格 testid 形状不对：${cell.testid}`);
      const knowledgePoint = rest.slice(0, lastDash);
      const bloom = rest.slice(lastDash + 1);

      const clicked = await page.tap(`[data-testid="${cell.testid}"]`);
      must(clicked.ok === true, `点不到矩阵单元格：${JSON.stringify(clicked)}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-supplement') !== null")),
        "编辑页出现补题面板",
        20_000,
      );
      artifacts.push(await page.screenshot(nextArtifactName("coverage-supplement")));

      const generated = await page.tap('[data-testid="edit-supplement-generate"]');
      must(generated.ok === true, `点不到「用模型生成这题」：${JSON.stringify(generated)}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-supplement-proposal') !== null")),
        "补题建议卡渲染",
        20_000,
      );
      artifacts.push(await page.screenshot(nextArtifactName("coverage-proposal")));

      const adopted = await page.tap('[data-testid="edit-supplement-adopt"]');
      must(adopted.ok === true, `点不到「加入草稿」：${JSON.stringify(adopted)}`);
      const diffText = await waitFor(
        async () => {
          const text = await page.evaluate(
            "var el = byTestId('edit-changes'); return el === null ? '' : el.textContent.trim();",
          );
          return text.includes("新增") ? text : null;
        },
        "加入草稿后 diff 出现新增题目",
        10_000,
      );
      const versionBefore = await draftVersionOf(page);
      const saved = await page.tap('[data-testid="edit-save"]');
      must(saved.ok === true, `点不到保存：${JSON.stringify(saved)}`);
      await waitFor(
        async () => {
          const n = await draftVersionOf(page);
          return typeof n === "number" && n !== versionBefore ? n : null;
        },
        "补题保存后版本号变化",
        20_000,
      );
      const detail = await page.evaluate(
        `return fetch(${JSON.stringify(`/api/forms/${publish.formId}`)}, { credentials: 'include' }).then(function (r) { return r.json(); });`,
      );
      const added = detail.schema.items.filter(
        (item) => item.knowledgePoint === knowledgePoint && item.bloom === bloom,
      );
      must(added.length >= 1, `保存后应有一道题落在 ${knowledgePoint} × ${bloom}`);

      // 手动路径：同一矩阵的另一格，只到「加题进草稿」为止，不保存。
      await page.goto(`${webBase}/dashboard/${publish.formId}`);
      await waitFor(
        async () =>
          (await page.evaluate("return document.querySelectorAll('[data-testid^=\"coverage-cell-\"]').length > 1")),
        "矩阵再次渲染",
        20_000,
      );
      await openCoverage(page);
      const second = await page.evaluate(`
        var all = document.querySelectorAll('[data-testid^="coverage-cell-"]');
        var el = all.length > 1 ? all[all.length - 1] : null;
        return el === null ? null : el.getAttribute('data-testid');
      `);
      must(second !== null && second !== cell.testid, "应能点到另一个矩阵格");
      const clickedSecond = await page.tap(`[data-testid="${second}"]`);
      must(clickedSecond.ok === true, `点不到第二个矩阵格：${JSON.stringify(clickedSecond)}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('edit-supplement-manual') !== null")),
        "第二个补题面板渲染",
        20_000,
      );
      const manual = await page.tap('[data-testid="edit-supplement-manual"]');
      must(manual.ok === true, `点不到「手动填写这题」：${JSON.stringify(manual)}`);
      await waitFor(
        async () => (await page.evaluate("var el = byTestId('edit-changes'); return el !== null && el.textContent.indexOf('新增') >= 0;")),
        "手动补题后 diff 出现新增题目",
        10_000,
      );
      artifacts.push(await page.screenshot(nextArtifactName("coverage-manual")));

      return { knowledgePoint, bloom, diff: diffText.slice(0, 80), generated: true, manual: true };
    });

    // 17) AI 辅助评分（A-23）：教师逐表单开启 → 批改面板出现按钮 →
    // 点一下只拿到建议分与理由，**不会自动保存**。
    const aiGrading = await step("AI 辅助评分：逐表单开启，建议分不自动保存", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/dashboard/${publish.formId}`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('dash-ai-grading') !== null")),
        "看板出现 AI 辅助评分开关",
        20_000,
      );
      const before = await page.evaluate(
        "var el = byTestId('dash-ai-grading'); return el === null ? null : el.checked;",
      );
      must(before === false, `AI 辅助评分默认应关闭，实际 ${JSON.stringify(before)}`);
      const toggled = await page.tap('[data-testid="dash-ai-grading"]');
      must(toggled.ok === true, `点不到 AI 辅助评分开关：${JSON.stringify(toggled)}`);
      await waitFor(
        async () => (await page.evaluate("var el = byTestId('dash-ai-grading'); return el !== null && el.checked === true;")),
        "AI 辅助评分开关打开",
        10_000,
      );

      await waitFor(
        async () =>
          (await page.evaluate("return document.querySelector('[data-testid^=\"dash-grade-\"]') !== null")),
        "看板提交行渲染出批改按钮",
        20_000,
      );
      const open = await page.tap('[data-testid^="dash-grade-"]');
      must(open.ok === true, `点不到看板批改按钮：${JSON.stringify(open)}`);
      await waitFor(
        async () => (await page.evaluate("return document.querySelector('[data-testid^=grade-ai-]') !== null;")),
        "批改面板出现 AI 辅助评分按钮",
        20_000,
      );
      const asked = await page.tap('[data-testid^="grade-ai-"]');
      must(asked.ok === true, `点不到 AI 辅助评分：${JSON.stringify(asked)}`);
      const suggestion = await waitFor(
        async () => {
          const value = await page.evaluate(
            "var el = document.querySelector('[data-testid^=grade-ai-suggestion-]'); return el === null ? null : el.textContent.trim();",
          );
          return typeof value === "string" && value.includes("建议") ? value : null;
        },
        "出现 AI 建议分与理由",
        20_000,
      );
      const saved = await page.evaluate("return document.querySelector('[data-testid=grade-saved]') !== null;");
      must(saved === false, "AI 建议不应自动保存");
      artifacts.push(await page.screenshot(nextArtifactName("ai-grading")));
      return { suggestion: suggestion.slice(0, 120), autoSaved: false };
    });

    // 18) 模型设置（2026-11-03）：四个模式、端点、模型名与 Key 都在网页里改。
    // 服务进程实际切到 replay 再切回 mock；Key 提交后只以 hasApiKey 出现，
    // 输入框会被清空——「不回显」是这条步骤的核心断言。
    const llmSettings = await step("模型设置：网页切换模式并填 Key，保存后不回显", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/settings`);
      await waitFor(
        async () => (await page.evaluate("return byTestId('llm-mode') !== null")),
        "模型设置页渲染",
        20_000,
      );
      const initialMode = await page.evaluate("return byTestId('llm-mode').value");
      must(initialMode === "mock", `设置页应显示启动模式 mock，实际 ${JSON.stringify(initialMode)}`);

      const setMode = async (value) =>
        page.evaluate(`
          var el = byTestId('llm-mode');
          var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.value;
        `);
      const noticeText = async () =>
        page.evaluate("var el = byTestId('llm-settings-notice'); return el === null ? null : el.textContent.trim();");
      const waitApplied = async (label) =>
        waitFor(
          async () => {
            const text = await noticeText();
            return typeof text === "string" && text.includes("已应用") ? text : null;
          },
          label,
          20_000,
        );

      must((await setMode("replay")) === "replay", "下拉没切到 replay");
      const savedReplay = await page.tap('[data-testid="llm-save"]');
      must(savedReplay.ok === true, `点不到保存：${JSON.stringify(savedReplay)}`);
      const replayNotice = await waitApplied("replay 设置保存成功");
      const afterReplay = await page.evaluate(
        "return fetch('/api/settings/llm', { credentials: 'include' }).then(function (r) { return r.text(); });",
      );
      must(afterReplay.includes('"mode":"replay"'), `设置没有立即生效：${afterReplay.slice(0, 200)}`);
      must(!afterReplay.includes('"apiKey"'), `设置响应出现了 apiKey 键：${afterReplay.slice(0, 200)}`);

      const key = "browser-test-key-not-real";
      const endpointTyped = await page.evaluate(
        `return setValue('[data-testid="llm-base-url"]', "https://api.example.com/v1");`,
      );
      const modelTyped = await page.evaluate(
        `return setValue('[data-testid="llm-model"]', "browser-model");`,
      );
      const keyTyped = await page.evaluate(
        `return setValue('[data-testid="llm-api-key"]', ${JSON.stringify(key)});`,
      );
      must(
        endpointTyped.ok === true && modelTyped.ok === true && keyTyped.ok === true,
        `端点/模型/Key 没填进去：${JSON.stringify({ endpointTyped, modelTyped, keyTyped })}`,
      );
      must((await setMode("mock")) === "mock", "下拉没切回 mock");
      const savedKey = await page.tap('[data-testid="llm-save"]');
      must(savedKey.ok === true, `点不到保存：${JSON.stringify(savedKey)}`);
      await waitApplied("mock + Key 设置保存成功");

      const afterKey = await page.evaluate(
        "return fetch('/api/settings/llm', { credentials: 'include' }).then(function (r) { return r.text(); });",
      );
      must(afterKey.includes('"mode":"mock"'), `模式没有切回 mock：${afterKey.slice(0, 200)}`);
      must(afterKey.includes('"hasApiKey":true'), `Key 没有被服务端接收：${afterKey.slice(0, 200)}`);
      must(!afterKey.includes(key), "设置接口回显了 Key");
      const cleared = await page.evaluate("return byTestId('llm-api-key').value");
      must(cleared === "", `保存后 Key 输入框应清空，实际 ${JSON.stringify(cleared)}`);
      must(!(await page.text()).includes(key), "设置页面文本里出现了 Key");
      artifacts.push(await page.screenshot(nextArtifactName("llm-settings")));

      // 留空 = 保持原 Key：再存一次（不填 Key）不应把 Key 清掉。
      // 这是设置页写明的语义，也是「改端点不必重输 Key」的实现保证。
      const kept = await page.tap('[data-testid="llm-save"]');
      must(kept.ok === true, `点不到再次保存：${JSON.stringify(kept)}`);
      await waitApplied("留空保持 Key 的保存成功");
      const afterKeep = await page.evaluate(
        "return fetch('/api/settings/llm', { credentials: 'include' }).then(function (r) { return r.text(); });",
      );
      must(afterKeep.includes('"hasApiKey":true'), `留空保存不应清掉 Key：${afterKeep.slice(0, 200)}`);

      return { initialMode, replayNotice, keyEchoed: false, blankKeepsKey: true };
    });

    // 19) 参考试卷与难度编辑（P24）。mock 模式没有模型，`styleNotes` 只如实写
    // 「收到 N 字，不解析原文」；这一步验的是参考卷 → 规划 → 回执的数据链路，
    // 以及「改难度 → 题型和同步」的配平，不冒充模型提炼质量（那由真实录像与 eval 负责）。
    const referenceStep = await step("参考试卷：粘贴后蓝图出现参考回执，难度分布可编辑", async () => {
      await page.viewport(DESKTOP_VIEWPORT);
      await page.goto(`${webBase}/`);
      await waitFor(
        async () => (await page.evaluate("return bySelector('#requirement-input') !== null")),
        "生成页需求输入框渲染",
      );
      // `/healthz` 是异步读的：先等界面确认运行模式，再断言开关；否则读到的是「未读到模式」。
      await waitFor(
        async () => {
          const hint = await page.evaluate(
            "var el = byTestId('web-search-hint'); return el === null ? null : el.textContent.trim();",
          );
          return typeof hint === "string" && hint.includes("离线演示模式") ? hint : null;
        },
        "界面读到时运行模式为离线（mock）",
        10_000,
      );
      // 离线模式（mock/replay/record）下联网参考必须禁用并写明原因：零外呼是硬保证。
      const searchState = await page.evaluate(`
        var box = byTestId('web-search');
        var hint = byTestId('web-search-hint');
        return { disabled: box === null ? null : box.disabled, hint: hint === null ? null : hint.textContent.trim() };
      `);
      must(searchState.disabled === true, `mock 模式下联网参考必须禁用：${JSON.stringify(searchState)}`);
      must((searchState.hint ?? "").includes("离线"), `禁用原因没有说明离线：${JSON.stringify(searchState.hint)}`);

      const marker = "教师参考-OMEGA";
      const referenceText = `${marker}\n一、选择题（每题 5 分）\n1. 已知函数 f(x)=x^2，求顶点坐标。`;
      const typedRequirement = await page.evaluate(
        `return setValue('#requirement-input', ${JSON.stringify(REQUIREMENT)});`,
      );
      const typedReference = await page.evaluate(
        `return setValue('[data-testid="plan-reference"]', ${JSON.stringify(referenceText)});`,
      );
      must(
        typedRequirement.ok === true && typedReference.ok === true,
        `需求或参考卷没填进去：${JSON.stringify({ typedRequirement, typedReference })}`,
      );
      must(await page.evaluate("return clickButtonByText('^生成表单$')"), "没找到「生成表单」按钮");
      await waitFor(
        async () => (await page.evaluate("return byTestId('plan-card') !== null")),
        "带参考卷的蓝图卡片出现",
        20_000,
      );
      const receipts = await page.evaluate(`
        var ref = byTestId('plan-reference-receipt');
        var search = byTestId('plan-search-receipt');
        return {
          reference: ref === null ? null : ref.textContent.trim(),
          search: search === null ? null : search.textContent.trim()
        };
      `);
      must((receipts.reference ?? "").includes("参考卷"), `没有参考卷回执：${JSON.stringify(receipts)}`);
      must(
        (receipts.search ?? "").includes("未启用"),
        `mock 下搜索回执应为未启用：${JSON.stringify(receipts)}`,
      );

      // 难度可编辑：基础 +1 后总题量与题型和同步增长，再改回原值（不留副作用）。
      const readDifficulty = `
        var block = byTestId('plan-difficulty');
        var inputs = block === null ? [] : Array.prototype.slice.call(block.querySelectorAll('input'));
        return {
          basic: inputs.length === 0 ? -1 : Number(inputs[0].value || 0),
          sum: inputs.reduce(function (total, input) { return total + Number(input.value || 0); }, 0)
        };
      `;
      const beforeEdit = await page.evaluate(`return (function () { ${readDifficulty} })();`);
      must(beforeEdit.basic >= 0, `蓝图里没有难度分布：${JSON.stringify(beforeEdit)}`);
      const bumped = await page.evaluate(
        `return setValue('[aria-label="基础难度数量"]', String(${String(beforeEdit.basic + 1)}));`,
      );
      must(bumped.ok === true, `难度输入框没改进去：${JSON.stringify(bumped)}`);
      await waitFor(
        async () => {
          const values = await page.evaluate(`return (function () { ${readDifficulty} })();`);
          return values.basic === beforeEdit.basic + 1 && values.sum === beforeEdit.sum + 1 ? values : null;
        },
        "改难度后题型和同步变化",
        10_000,
      );
      artifacts.push(await page.screenshot(nextArtifactName("plan-reference")));
      const restored = await page.evaluate(
        `return setValue('[aria-label="基础难度数量"]', String(${String(beforeEdit.basic)}));`,
      );
      must(restored.ok === true, `难度输入框没改回去：${JSON.stringify(restored)}`);
      await waitFor(
        async () => {
          const values = await page.evaluate(`return (function () { ${readDifficulty} })();`);
          return values.basic === beforeEdit.basic && values.sum === beforeEdit.sum ? values : null;
        },
        "难度改回原值",
        10_000,
      );

      // 界面不回显 styleNotes；直接调 API 证明它进了 plan 响应，且参考原文没被带出。
      const directText = await page.evaluate(`
        return fetch('/api/plan', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-intentform-csrf': '1' },
          body: JSON.stringify({
            requirement: ${JSON.stringify(REQUIREMENT)},
            reference: ${JSON.stringify(referenceText)}
          })
        }).then(function (response) { return response.text(); });
      `);
      const direct = JSON.parse(directText);
      must(direct.ok === true, `直接调用规划 API 失败：${directText.slice(0, 200)}`);
      must(
        typeof direct.blueprint.styleNotes === "string" && direct.blueprint.styleNotes.length > 0,
        `plan 响应缺少 styleNotes：${directText.slice(0, 300)}`,
      );
      must(
        direct.blueprint.styleNotes.includes("参考卷"),
        `styleNotes 没有说明参考卷：${String(direct.blueprint.styleNotes)}`,
      );
      must(!directText.includes(marker), "plan 响应回显了参考卷原文");
      must(direct.searchStatus === "off", `mock 下 searchStatus 应为 off：${String(direct.searchStatus)}`);

      return {
        receipt: receipts,
        difficulty: { before: beforeEdit.basic, after: beforeEdit.basic + 1, restored: beforeEdit.basic },
        styleNotes: direct.blueprint.styleNotes.slice(0, 120),
        searchStatus: direct.searchStatus,
      };
    });

    const summary = {
      ok: true,
      chrome,
      ports: { app: apiPort, cdp: debugPort },
      form: { formId: publish.formId, slug: publish.slug, publishMode: publish.mode },
      login,
      generate: {
        source: generate.source,
        planTitleEdited: generate.planTitleEdited,
        previewTitleEdited: generate.editedTitle,
      },
      student,
      submitted,
      edited,
      clarify,
      survey: surveyCollection,
      printed,
      answerReview,
      darkMode,
      directGenerate,
      singleItem,
      supplement,
      aiGrading,
      llmSettings,
      reference: referenceStep,
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
