/**
 * 开发期的假数据流源。
 *
 * 用**动态** `import()` 拉假帧，而不是顶层 import：生产构建里 `?stream=fixture`
 * 会被 `selectStreamMode()` 拒掉（只认 dev），假数据也就不该进主 chunk。
 * 这样"演示数据"三个字有了技术保证，而不是靠注释提醒。
 */

import { createFixtureStreamSource, type StreamSource } from "./source";

export const DEMO_NOTICE =
  "当前是假数据模式（?stream=fixture）：时间线由本地假帧驱动，尚未与后端联调。";

export function createDemoStreamSource(delayMs = 40): StreamSource {
  return async function* demoSource(request) {
    const { FIXTURE_CHUNKS } = await import("./__fixtures__/fake-frames");
    yield* createFixtureStreamSource(FIXTURE_CHUNKS, { delayMs })(request);
  };
}
