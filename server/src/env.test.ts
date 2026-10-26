/**
 * 启动配置：缺省值、生产环境 fail fast、以及「不许用一次性密钥上线」。
 *
 * 这些断言看起来很琐碎，但每一条都对应一次真实的翻车：
 * - `DATABASE_PATH` 缺省值曾经写成 `./.data/…`，而 `.gitignore` 只忽略了 `data/`，
 *   等于把每个人的本地库都变成未跟踪文件；
 * - 生产用一次性 `SESSION_SECRET` 不会报错，只会让所有教师「莫名其妙掉登录」。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_PATH, readServerEnv } from "./env.ts";

describe("readServerEnv", () => {
  it("DATABASE_PATH 缺省与 .env.example 一致（./data/intentform.db）", () => {
    const env = readServerEnv({ SESSION_SECRET: "secret" });
    expect(env.databasePath).toBe("./data/intentform.db");
    expect(DEFAULT_DATABASE_PATH).toBe("./data/intentform.db");
  });

  it("限流配额缺省：提交 30 次/分钟、生成 10 次/分钟", () => {
    const env = readServerEnv({ SESSION_SECRET: "secret" });
    expect(env.rateSubmitPerMin).toBe(30);
    expect(env.rateGeneratePerMin).toBe(10);
  });

  it("限流配额可配，非法值直接抛错（不是静默落回缺省）", () => {
    const env = readServerEnv({ SESSION_SECRET: "secret", RATE_SUBMIT_PER_MIN: "3" });
    expect(env.rateSubmitPerMin).toBe(3);
    expect(() => readServerEnv({ SESSION_SECRET: "secret", RATE_SUBMIT_PER_MIN: "0" })).toThrow(
      /RATE_SUBMIT_PER_MIN/,
    );
  });

  it("非生产环境允许一次性 SESSION_SECRET，但标注来源", () => {
    const env = readServerEnv({});
    expect(env.sessionSecret).toHaveLength(64);
    expect(env.sessionSecretSource).toBe("ephemeral");
  });

  it("NODE_ENV=production 且没设 SESSION_SECRET → 启动即抛错", () => {
    expect(() => readServerEnv({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
    // 设了就能起来。
    const env = readServerEnv({ NODE_ENV: "production", SESSION_SECRET: "real-secret" });
    expect(env.sessionSecretSource).toBe("env");
  });

  it("WEB_INDEX_HTML 缺省为空（表示自动探测 web/dist）", () => {
    expect(readServerEnv({ SESSION_SECRET: "secret" }).webIndexHtml).toBe("");
    expect(
      readServerEnv({ SESSION_SECRET: "secret", WEB_INDEX_HTML: "/srv/index.html" }).webIndexHtml,
    ).toBe("/srv/index.html");
  });

  it("APP_ORIGIN 规范化：去尾斜杠、小写", () => {
    const env = readServerEnv({ SESSION_SECRET: "secret", APP_ORIGIN: "HTTP://A.Example:5173/" });
    expect(env.appOrigin).toBe("http://a.example:5173");
  });
});
