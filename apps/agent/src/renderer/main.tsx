import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// 채팅·도구 카드·확장 UI는 Pi Desktop에서 복사한 컴포넌트를 쓰므로 스타일도 함께 가져온다 (vendor/README.md).
import "../vendor/renderer/styles.css";
import "./agent.css";
import "./layout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
