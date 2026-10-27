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
 * 它自己起三个进程，跑完全部收掉：
 *   1. `server/src/seed.ts`（一次性写入演示教师 + 2 张表单 + 30 条提交，库在临时目录）；
 *   2. `server/src/main.ts`，`LLM_MODE=mock`（确定性生成流，不联网、不花额度）；
 *   3. `web/node_modules/vite/bin/vite.js`（dev server，代理 /api 与 /f 到上面那个服务）；
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
const VITE_ENTRY = join(ROOT, "web", "node_modules", "vite", "bin", "vite.js");
const EVIDENCE_DIR = resolve(ROOT, process.env["EVIDENCE_DIR"] ?? join("docs", "evidence"));

/** 演示账号：`server/src/seed.ts` 里写死的那个（密码只在本机演示库生效）。 */
const DEMO_EMAIL = "teacher@example.com";
const DEMO_PASSWORD = "intentform-demo";

/**
 * 生成用的需求文本。刻意不含「问卷/调查/反馈」这类词：`inferFormKind` 见到就会把表单
 * 判成 survey，而 survey 不许有答案与分值（R3），学生页就没有"作答→判分"可走了。
 */
const REQUIREMENT = "出一份二次函数随堂测：单选、填空、数值和简答各一道，共 20 分";

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

async function spawnVite(webPort, apiPort) {
  if (!existsSync(VITE_ENTRY)) {
    throw new Error(`找不到 vite：${VITE_ENTRY}（先在仓库根跑 pnpm install）`);
  }
  const sink = { stdout: [], stderr: [] };
  const child = spawn(
    process.execPath,
    [VITE_ENTRY, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    {
      cwd: join(ROOT, "web"),
      env: { ...process.env, VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${String(apiPort)}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  collect(child, sink);
  const base = `http://127.0.0.1:${String(webPort)}`;
  await waitFor(
    async () => {
      const response = await fetch(`${base}/`).catch(() => null);
      return response !== null && response.ok;
    },
    `vite 就绪（stderr=${sink.stderr.join("").slice(-400)}）`,
    60_000,
    250,
  );
  return { child, sink };
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
  function clickTestId(id) {
    var el = byTestId(id);
    if (el === null) return false;
    el.click();
    return true;
  }
  function clickChoice(fieldId, optionId) {
    var label = byTestId('fill-' + fieldId + '-' + optionId);
    if (label === null) {
      return { ok: false, reason: 'missing label', testIds: Array.prototype.slice.call(document.querySelectorAll('[data-testid^="fill-' + fieldId + '"]')).map(function (el) { return el.getAttribute('data-testid') + ':' + el.tagName; }) };
    }
    var input = label.querySelector('input');
    if (input === null) { label.click(); return { ok: true, checked: true, via: 'label' }; }
    label.click();
    var afterLabel = input.checked;
    if (!afterLabel) input.click();
    var state = Array.prototype.map.call(document.querySelectorAll('input[name="' + fieldId + '"]'), function (el) { return el.checked ? 1 : 0; }).join('');
    return { ok: true, checked: input.checked, afterLabel: afterLabel, afterInput: input.checked, group: state, via: afterLabel ? 'label' : 'input', type: input.type };
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

const SCORED_TYPES = new Set(["single", "multi", "fill", "number"]);

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
  const webPort = await findFreePort();
  const debugPort = await findFreePort();
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;
  const webBase = `http://127.0.0.1:${String(webPort)}`;

  const env = {
    PORT: String(apiPort),
    DATABASE_PATH: dbPath,
    // 每次运行现生成：给密钥扫描器少一个假阳性，也不需要跨运行保持同一会话。
    SESSION_SECRET: `loop-session-${randomUUID()}`,
    SESSION_TTL_HOURS: "1",
    COOKIE_SECURE: "false",
    // 浏览器从 vite 的源出发，所以 APP_ORIGIN 是 vite 的地址（CSRF 逐字节比对 Origin）。
    APP_ORIGIN: webBase,
    LLM_MODE: "mock",
    ARGON2_MEMORY_KIB: "8192",
  };

  const children = [];
  let cdp = null;
  let failure = null;

  try {
    await runToCompletion(SEED_ENTRY, env, "种子数据写入");
    const server = await spawnServer(env, apiPort);
    children.push(server.child);
    const vite = await spawnVite(webPort, apiPort);
    children.push(vite.child);
    const browser = await spawnChrome(chrome, debugPort, chromeProfile);
    children.push(browser.child);

    cdp = await Cdp.connect(browser.target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", DESKTOP_VIEWPORT);
    const page = new Page(cdp);

    const request = makeApi(apiBase, webBase);
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
      artifacts.push(await page.screenshot("01-login.png"));
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
      // mock 是内置脚本 + 一条故意写坏再修复的题：等前端把 done 状态渲染出来。
      await waitFor(async () => (await page.text()).includes("生成完成"), "生成流走完（出现「生成完成」）", 30_000);
      artifacts.push(await page.screenshot("02-generate.png"));
      const source = await page.evaluate(
        "var el = byTestId('data-source'); return el === null ? '' : el.textContent.trim();",
      );
      const timeline = await page.text();
      must(timeline.includes("修复") || timeline.includes("repair"), "时间线里没有修复记录（mock 必然有一次）");
      return { requirement: REQUIREMENT, source, sawRepairEntry: true };
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
      artifacts.push(await page.screenshot("03b-published-dashboard.png"));
      return { mode, formId, versionId, slug, buttonLabels: await page.evaluate("return buttonLabels()") };
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

      if (process.env["PROBE_CLICK"] === "1") {
        const box = await page.evaluate(`
          var label = byTestId('fill-q_single-b');
          if (label === null) return null;
          label.scrollIntoView({ block: 'center' });
          var rect = label.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
        `);
        const probe = { box };
        if (box !== null) {
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
          await sleepMs(150);
          probe.afterTrustedClick = await page.evaluate(
            "var el = byTestId('fill-q_single-b'); var input = el === null ? null : el.querySelector('input'); return input === null ? null : { checked: input.checked, group: Array.prototype.map.call(document.querySelectorAll('input[name=q_single]'), function (i) { return i.checked ? 1 : 0; }).join('') };",
          );
        }
        process.stdout.write(`PROBE ${JSON.stringify(probe)}\n`);
        throw new Error("PROBE 结束（预期失败，用于定位点击问题）");
      }

      const formDetail = await request("GET", `/api/forms/${publish.formId}`, { cookie });
      must(formDetail.status === 200, `读表单详情失败（${String(formDetail.status)}）：${formDetail.text}`);
      const schema = formDetail.json.schema;
      const maxScore = schema.items
        .filter((item) => SCORED_TYPES.has(item.type))
        .reduce((sum, item) => sum + item.score, 0);

      // 全部答对：这样看板上的那一行分数是个确定的数字，能被断死。
      //
      // 只在这一步「点」，判定放到下一次 evaluate：单选是**受控组件**，`checked` 要等
      // React 重渲染才反映到 DOM；在同一个 evaluate 里同步读 `input.checked` 必然是 false
      // （本脚本第一版就是这样假失败，报"控件没答上"，其实点击已经生效）。
      const clicked = await page.evaluate(`
        var items = ${JSON.stringify(schema.items)};
        var touched = [];
        for (var index = 0; index < items.length; index += 1) {
          var item = items[index];
          if (item.type === 'single' && typeof item.answer === 'string') {
            clickChoice(item.id, item.answer);
            touched.push(item.id);
          } else if (item.type === 'multi' && Array.isArray(item.answer)) {
            for (var k = 0; k < item.answer.length; k += 1) clickChoice(item.id, item.answer[k]);
            touched.push(item.id);
          } else if (item.type === 'number' && item.answer !== undefined && item.answer !== null) {
            setValue('[data-testid="fill-' + item.id + '"]', String(item.answer.value));
            touched.push(item.id);
          } else if (item.type === 'fill' && Array.isArray(item.answer)) {
            setValue('[data-testid="fill-' + item.id + '"]', item.answer.join('／'));
            touched.push(item.id);
          } else if (item.type === 'short') {
            setValue('[data-testid="fill-' + item.id + '"]', '浏览器闭环脚本填写');
            touched.push(item.id);
          }
        }
        return touched;
      `);

      // 每一项的真实状态：选项类看受控 radio/checkbox 的选中态，输入类看 value 非空。
      const stillEmpty = await waitFor(
        async () =>
          page.evaluate(`
            var items = ${JSON.stringify(schema.items)};
            var missing = [];
            for (var index = 0; index < items.length; index += 1) {
              var item = items[index];
              if (item.type === 'single' && typeof item.answer === 'string') {
                var picked = document.querySelector('[data-testid="fill-' + item.id + '-' + item.answer + '"] input');
                if (picked === null || picked.checked !== true) missing.push(item.id + ':single');
              } else if (item.type === 'multi' && Array.isArray(item.answer)) {
                for (var k = 0; k < item.answer.length; k += 1) {
                  var box = document.querySelector('[data-testid="fill-' + item.id + '-' + item.answer[k] + '"] input');
                  if (box === null || box.checked !== true) missing.push(item.id + ':multi:' + item.answer[k]);
                }
              } else {
                var input = document.querySelector('[data-testid="fill-' + item.id + '"]');
                if (input === null || String(input.value).trim() === '') missing.push(item.id + ':text');
              }
            }
            return missing.length === 0 ? true : missing;
          `),
        "所有控件都进入已作答状态",
        10_000,
      );
      must(
        stillEmpty === true,
        `这些控件没答上：${JSON.stringify(stillEmpty)}（已点击 ${JSON.stringify(clicked)}）`,
      );
      artifacts.push(await page.screenshot("05-student-answered.png"));
      return { slug: publish.slug, maxScore, answeredFields: clicked.length };
    });

    // 5) 提交并看到成功卡片
    const submitted = await step("提交答卷并看到成功卡片", async () => {
      must(await page.evaluate("return clickTestId('fill-submit')"), "点不到提交按钮");
      await waitFor(async () => (await page.text()).includes("答案已记录"), "提交成功卡片", 20_000);
      artifacts.push(await page.screenshot("06-submitted.png"));
      const text = await page.text();
      const scoreLine = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
      must(scoreLine !== null, `成功卡片里没看到 得分/满分：${text.slice(0, 200)}`);
      return { score: Number(scoreLine[1]), maxScore: Number(scoreLine[2]), text: scoreLine[0] };
    });
    must(
      submitted.score === student.maxScore,
      `全部答对却只拿到 ${String(submitted.score)}/${String(student.maxScore)}`,
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
      const expectedScoreText = `${String(submitted.score)} / ${String(student.maxScore)}`;
      must(
        cells.includes(expectedScoreText),
        `看板第一行的得分应是「${expectedScoreText}」，实际 ${JSON.stringify(cells)}`,
      );
      const stats = await page.text();
      return { rowCount, firstRowCells: cells, expectedScoreText, sawStats: stats.includes("提交数") };
    });

    const summary = {
      ok: true,
      chrome,
      ports: { api: apiPort, web: webPort, cdp: debugPort },
      form: { formId: publish.formId, slug: publish.slug, publishMode: publish.mode },
      login,
      generate: { source: generate.source },
      student,
      submitted,
      dashboard,
      steps,
      artifacts,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    failure = error;
  } finally {
    cdp?.close();
    for (const child of children.reverse()) killTree(child);
    await sleepMs(400);
    if (process.env["KEEP_RUN_DIR"] === "1") {
      process.stdout.write(`[loop] 临时目录已保留：${runDir}\n`);
    } else {
      rmSync(runDir, { recursive: true, force: true });
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
