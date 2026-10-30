/** 生产页面的响应安全策略。开发 Vite 不使用这条策略，避免妨碍热更新。 */
export const PRODUCTION_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'self'; frame-ancestors 'none'";

export function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env["NODE_ENV"] === "production";
}
