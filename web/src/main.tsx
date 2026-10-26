import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/index.css";

const container = document.getElementById("root");

if (container === null) {
  // 宁可白屏并报错，也不要渲染到一个隐式创建出来的 div 上——那样布局问题会被掩盖。
  throw new Error("web/index.html 缺少 #root 容器");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
