import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 开发期把 `/api/*` 反代到本地 server（默认 8787），前端代码里因此永远写相对路径 `/api`。
 * 生产构建不依赖这个代理：那时前后端同源由部署层决定（I9）。
 * `VITE_DEV_PROXY_TARGET` 只影响 dev server，不进产物。
 */
const proxyTarget = process.env["VITE_DEV_PROXY_TARGET"] ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: proxyTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});
