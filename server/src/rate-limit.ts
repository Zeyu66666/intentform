/**
 * 限流（《计划 v3.0》§5「限流、调用边界」是**必须保留**项）。
 *
 * 三个刻意的选择：
 *
 * 1. **固定窗口，不是滑动窗口/令牌桶**。这个服务的配额是「每分钟 N 次」这种粗粒度
 *    保护（挡住脚本刷、挡住一次误发的循环），固定窗口的误差（窗口边界最多放过
 *    2N 次）在这个量级上无所谓，换来的是每个 key 只有一个 `{windowStart, count}`。
 *    滑动窗口要么存时间戳数组（内存随请求数长），要么两桶加权（两倍状态、还要
 *    解释为什么加权），都不值得为「精确到秒的公平」付出。
 * 2. **计数器在进程内存里**。单实例 Node + 同步 SQLite，本来就没有第二台机器要
 *    对齐；重启清零是**可接受的**（限流不是配额账本，不是计费依据）。
 *    如果将来要跨实例，把 `hit` 换成 Redis 的 INCR + EXPIRE 即可，接口不变。
 * 3. **key 里带 IP 哈希而不是明文 IP**，与 `submissions.ip_hash` 同一口径
 *    （`sha256(SESSION_SECRET + ip)`）：能按来源归并计数，又不把明文 IP 留在内存
 *    与日志里。
 *
 * 超限响应是普通 JSON（429 + `rate_limited`），不是断流：`POST /api/generate` 的
 * SSE 在限流判定时**还没有开始写流**，所以前端拿到的是一个能解析的错误体，
 * 而不是半截事件流。
 */

import { createHash } from "node:crypto";

export type RateLimitVerdict =
  | { readonly ok: true }
  /** `retryAfterSeconds` 直接写进 `Retry-After` 头与提示语。 */
  | { readonly ok: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /**
   * 记一次调用。
   *
   * `limitPerWindow <= 0` 表示「不限」——配置里显式写 0 的场景（压测、内网演示）
   * 不必再包一层 if。
   */
  hit(key: string, limitPerWindow: number, nowMs?: number): RateLimitVerdict;
  /** 当前跟踪的 key 数（测试与排查用）。 */
  size(): number;
}

interface Window {
  windowStart: number;
  count: number;
}

/** 超过这个 key 数就顺手清理过期窗口，避免长期运行时 Map 只涨不落。 */
const PRUNE_THRESHOLD = 4_096;

export function createRateLimiter(windowMs = 60_000): RateLimiter {
  const windows = new Map<string, Window>();

  function prune(now: number): void {
    for (const [key, window] of windows) {
      if (now - window.windowStart >= windowMs) windows.delete(key);
    }
  }

  return {
    hit(key, limitPerWindow, nowMs = Date.now()) {
      if (limitPerWindow <= 0) return { ok: true };
      const current = windows.get(key);
      const windowStart = current === undefined ? nowMs : current.windowStart;
      const count = current === undefined ? 0 : current.count;

      // 跨窗口：计数归零，窗口从本次请求重新开始。
      if (nowMs - windowStart >= windowMs) {
        windows.set(key, { windowStart: nowMs, count: 1 });
        if (windows.size > PRUNE_THRESHOLD) prune(nowMs);
        return { ok: true };
      }
      if (count >= limitPerWindow) {
        const remainingMs = windowStart + windowMs - nowMs;
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)) };
      }
      windows.set(key, { windowStart, count: count + 1 });
      return { ok: true };
    },
    size() {
      return windows.size;
    },
  };
}

/**
 * 限流 key：`<路由名>:<IP 哈希>`。
 *
 * 两种主体共用同一套口径——提交端是匿名学生（没有身份），生成端是教师但请求体里
 * 也可能不带会话；按 IP 哈希计数是唯一两边都能用、且不需要先鉴权的分桶方式。
 */
export function rateLimitKey(routeName: string, sessionSecret: string, ip: string): string {
  const digest = createHash("sha256").update(`${sessionSecret}${ip}`).digest("hex");
  return `${routeName}:${digest}`;
}
