import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Mate의 데이터 홈. 기본은 `~/.pi-desktop-mate` (설계 DESIGN-MATE.md §2.2).
 * Pi Desktop(`~/.pi-desktop`)·Agent(`~/.pi-desktop-agent`)와 나눈다. 테스트·개발에서는 `MATE_HOME`으로 바꾼다.
 */
export function mateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MATE_HOME || join(homedir(), ".pi-desktop-mate");
}

export function matePaths(home: string) {
  return {
    home,
    config: join(home, "config.json"),
    duties: join(home, "duties"),
    requests: join(home, "requests"),
    state: join(home, "state.json"),
    runs: join(home, "runs"),
    inbox: join(home, "inbox.jsonl"),
    inboxState: join(home, "inbox-state.json"),
    sessions: join(home, "sessions"),
    /** act 실행의 작업 공간(git worktree) */
    worktrees: join(home, "worktrees"),
    runDir: join(home, "run"),
    pid: join(home, "run", "mated.pid"),
    log: join(home, "run", "mated.log"),
    /** 활동 관찰 기록 (요약만, M4) */
    activity: join(home, "activity.jsonl"),
    /** 휴대폰 연결 상태 (실행기가 씀) */
    remote: join(home, "remote.json"),
    /** Mate 대화 기록 (추가만) */
    chat: join(home, "chat.jsonl"),
    /** 대화의 Pi 세션 (이어 쓴다) */
    chatSessions: join(home, "chat", "sessions"),
    /** 앱이 넣는 대화 요청 */
    chatRequests: join(home, "chat", "requests"),
    /** 대화 한 차례의 할 일 목록 (mate_do) */
    chatActions: join(home, "chat", "actions"),
    /** 대화에 붙인 이미지 (Pi에 넘기고 답한 뒤 지운다) */
    chatImages: join(home, "chat", "images"),
    /** 대화 상태 (실행기가 씀: 세션 번호·생각 중·결과를 기다리는 실행) */
    chatState: join(home, "chat", "state.json"),
    /** 임무가 고르는 스킬과 MCP 서버 (DESIGN-APPS.md §3.4). Pi 형식 그대로 */
    skills: join(home, "skills"),
    mcp: join(home, "mcp.json"),
    /** 지운 임무·실행 기록·대화 (되살리거나 비운다, DESIGN-APPS.md §3.2) */
    trash: join(home, "trash"),
  };
}

export type MatePaths = ReturnType<typeof matePaths>;
