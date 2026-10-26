import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 开发期把 `/api/*` 反代到本地 server（默认 8787），前端代码里因此永远写相对路径 `/api`。
 * 生产构建不依赖这个代理：那时前后端同源由部署层决定（I9）。
 * `VITE_DEV_PROXY_TARGET` 只影响 dev server，不进产物。
 */
const proxyTarget = process.env["VITE_DEV_PROXY_TARGET"] ?? "http://127.0.0.1:8787";

/**
 * Windows 上编辑器/工具的**原子写**会先建 `.name.tsx.<pid>.<rand>.tmpdir/` 再把文件塞进去，
 * 落盘瞬间再 rename 覆盖。chokidar 在 rename 与 tmpdir 删除之间抢到 `EBUSY`/`ENOENT` 时，
 * Vite 的 watcher 会把错误直接抛到进程上，dev server 直接退出（页面白屏，且日志只是一行 EBUSY）。
 * 这些临时目录永远不是源码，忽略掉最省事：
 * - `**\/.*.tmpdir/**`：原子写的目录
 * - `**\/*.tmp`、`**\/*.swp`、`**\/*~`：残留交换/备份文件
 * 两者都是"新增忽略项"，不影响正常源码监听。
 */
const WATCH_IGNORED = ["**/.*.tmpdir/**", "**/*.tmp", "**/*.swp", "**/*~"] as const;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [...WATCH_IGNORED],
    },
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
