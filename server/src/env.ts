/**
 * 服务端运行时配置（《计划 v3.0》§5、`.env.example`）。
 *
 * 只读一次、只认模板里列出的变量。刻意**不读 `.env` 文件**：仓库里没有 dotenv
 * 依赖，也不该为了本地方便再加一个；环境变量由启动命令注入（`pnpm dev:server`
 * 或部署平台的 env），测试则显式传入一个对象。这样「测试不读 `.env`」这条
 * 纪律是结构上成立的，而不是靠自觉。
 *
 * `SESSION_SECRET` 的两种口径，按 `NODE_ENV` 分开：
 *
 * - **开发/演示**（非 production）留空时不抛错，而是生成一次性随机密钥并标注来源：
 *   计划里的默认演示路径是 `PORT=8787 node .../main.ts`（没有 `.env`），启动即崩
 *   会让「10 分钟复现」第一条命令就失败。代价是重启后旧 cookie 全部失效，这一点由
 *   `main.ts` 启动日志明说，不静默。
 * - **`NODE_ENV=production`** 留空则**启动即抛错**（fail fast）。生产用一次性密钥
 *   意味着每次滚动重启把所有教师踢下线，且多实例之间互相不认——这种事故不会报错，
 *   只会表现成「登录莫名其妙失效」，所以必须在启动那一秒炸掉。
 */

import { randomBytes } from "node:crypto";

/** 与 `packages/schema/src/api.ts` 的契约无关，纯粹是本服务的启动配置。 */
export interface ServerEnv {
  /** 允许发出修改类请求的来源（CORS + CSRF 双重口径）；空串表示「生产同源，按 Host 推断」。 */
  readonly appOrigin: string;
  readonly databasePath: string;
  readonly sessionSecret: string;
  /** `env`：来自 SESSION_SECRET；`ephemeral`：本次进程随机生成，重启即失效。 */
  readonly sessionSecretSource: "env" | "ephemeral";
  readonly sessionTtlHours: number;
  /** 只有 HTTPS 部署才开，本地 http://localhost 必须关（否则登录当场失效）。 */
  readonly cookieSecure: boolean;
  /** argon2 的内存成本（KiB），默认 64 MiB。 */
  readonly argon2MemoryKib: number;
  /** `POST /api/submissions` 的单窗口配额（每个 IP 哈希每分钟）。 */
  readonly rateSubmitPerMin: number;
  /** `POST /api/generate` 的单窗口配额（每个 IP 哈希每分钟）。 */
  readonly rateGeneratePerMin: number;
  /**
   * 生产同源部署时 `/f/:slug` 要托管的 SPA 壳文件路径；空串表示按
   * `<cwd>/web/dist/index.html`、`<cwd>/../web/dist/index.html` 自动探测。
   *
   * 之所以做成配置而不是写死两个候选路径：服务进程的 cwd 不一定是仓库根
   * （`node server/dist/main.js`、systemd 的 WorkingDirectory、容器只挂 dist），
   * 而且测试需要一条**确定没有**的路径来锁住「缺产物时回什么」。
   */
  readonly webIndexHtml: string;
}

/** 与 `.env.example` 的 DATABASE_PATH 同一口径；`data/` 与 `*.db` 都在 .gitignore 里。 */
export const DEFAULT_DATABASE_PATH = "./data/intentform.db";

/** 前端开发服务器地址；生产同源部署时把 APP_ORIGIN 留空。 */
export const FALLBACK_APP_ORIGIN = "http://127.0.0.1:5173";

const DEFAULT_SESSION_TTL_HOURS = 72;
const DEFAULT_ARGON2_MEMORY_KIB = 65_536;
/** OWASP 对 argon2id 的内存下限建议之一是 19 MiB；低于 8 MiB 的配置直接拒绝。 */
const MIN_ARGON2_MEMORY_KIB = 8_192;
const MAX_SESSION_TTL_HOURS = 24 * 365;
/** 与 `.env.example` 的 RATE_SUBMIT_PER_MIN / RATE_GENERATE_PER_MIN 同口径。 */
const DEFAULT_RATE_SUBMIT_PER_MIN = 30;
const DEFAULT_RATE_GENERATE_PER_MIN = 10;
const MAX_RATE_PER_MIN = 100_000;

function readString(raw: string | undefined): string {
  return raw === undefined ? "" : raw.trim();
}

function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const text = readString(raw);
  if (text === "") return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid ${name}: ${text}（应为 ${String(min)}–${String(max)} 的整数）`);
  }
  return parsed;
}

/** 来源比较用的规范化：去尾斜杠、小写。`http://A/` 与 `http://a` 视为同一来源。 */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

export function readServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const declaredSecret = readString(env["SESSION_SECRET"]);
  const appOrigin = readString(env["APP_ORIGIN"]);
  const databasePath = readString(env["DATABASE_PATH"]);
  // 生产环境不许用一次性密钥：多实例之间互不认、每次重启把所有人踢下线，
  // 而且这两种症状都不会报错，只表现成「登录莫名其妙失效」。
  if (readString(env["NODE_ENV"]) === "production" && declaredSecret === "") {
    throw new Error(
      "NODE_ENV=production 时必须显式设置 SESSION_SECRET（生产不允许使用一次性随机密钥）",
    );
  }
  return {
    appOrigin: appOrigin === "" ? "" : normalizeOrigin(appOrigin),
    databasePath: databasePath === "" ? DEFAULT_DATABASE_PATH : databasePath,
    sessionSecret:
      declaredSecret === "" ? randomBytes(32).toString("hex") : declaredSecret,
    sessionSecretSource: declaredSecret === "" ? "ephemeral" : "env",
    sessionTtlHours: readInt(
      env["SESSION_TTL_HOURS"],
      DEFAULT_SESSION_TTL_HOURS,
      1,
      MAX_SESSION_TTL_HOURS,
      "SESSION_TTL_HOURS",
    ),
    cookieSecure: readString(env["COOKIE_SECURE"]).toLowerCase() === "true",
    argon2MemoryKib: readInt(
      env["ARGON2_MEMORY_KIB"],
      DEFAULT_ARGON2_MEMORY_KIB,
      MIN_ARGON2_MEMORY_KIB,
      Number.MAX_SAFE_INTEGER,
      "ARGON2_MEMORY_KIB",
    ),
    rateSubmitPerMin: readInt(
      env["RATE_SUBMIT_PER_MIN"],
      DEFAULT_RATE_SUBMIT_PER_MIN,
      1,
      MAX_RATE_PER_MIN,
      "RATE_SUBMIT_PER_MIN",
    ),
    rateGeneratePerMin: readInt(
      env["RATE_GENERATE_PER_MIN"],
      DEFAULT_RATE_GENERATE_PER_MIN,
      1,
      MAX_RATE_PER_MIN,
      "RATE_GENERATE_PER_MIN",
    ),
    webIndexHtml: readString(env["WEB_INDEX_HTML"]),
  };
}

export const MUTATING_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

export function isMutatingMethod(method: string | undefined): boolean {
  return method !== undefined && MUTATING_METHODS.includes(method.toUpperCase());
}
