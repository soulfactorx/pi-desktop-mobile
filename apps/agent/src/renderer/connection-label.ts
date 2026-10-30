import type { ConnectionState } from "../shared/api";

/** 상단 바의 연결 표시 (글자, 배지 색) */
export function connectionLabel(state: ConnectionState): { text: string; tone: "ok" | "bad" | "" } {
  switch (state.status) {
    case "connected":
      return { text: `연결됨 · Host Agent ${state.host.agentVersion}`, tone: "ok" };
    case "disconnected":
      return { text: `연결 끊김: ${state.reason}`, tone: "bad" };
    case "connecting":
      return { text: "연결 중…", tone: "" };
    default:
      return { text: "대기", tone: "" };
  }
}
