import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// KaTeX 的字体随包发布（不走 CDN），公式才能离线渲染。
import "katex/dist/katex.min.css";

import { RouteView } from "./RouteView";
import "./styles/index.css";
import { applyStoredTheme } from "./theme/useTheme";

// 在 React 渲染之前把主题写进 <html>：晚一帧，深色系统用户就会看到白闪。
applyStoredTheme();

const container = document.getElementById("root");

if (container === null) {
  // 宁可白屏并报错，也不要渲染到一个隐式创建出来的 div 上——那样布局问题会被掩盖。
  throw new Error("web/index.html 缺少 #root 容器");
}

createRoot(container).render(
  <StrictMode>
    <RouteView />
  </StrictMode>,
);
