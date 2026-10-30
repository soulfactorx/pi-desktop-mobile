/**
 * 작업 기록의 모양. 앱의 렌더러도 타입으로 쓰므로 이 파일은 아무것도 import하지 않는다.
 */

/** waiting: 피어가 맡긴 작업이 사람의 승인을 기다리거나, 피어에게 맡긴 작업이 상대 승인을 기다리는 중 */
export type TaskStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface TaskRecord {
  id: string;
  title: string;
  instruction: string;
  /** delegate: 대화에서 맡김, schedule: 예약 실행, peer-in: 다른 에이전트가 맡김, peer-out: 다른 에이전트에게 맡김 */
  origin: "delegate" | "schedule" | "peer-in" | "peer-out";
  status: TaskStatus;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  /** 피어 작업: 상대 에이전트와 상대 쪽 작업 id(peer-out) */
  peer?: { id: string; name: string; remoteId?: string };
  /** peer-in: 사람이 승인했는가 (승인하면 스케줄러가 cwd에서 시작한다) */
  approval?: "pending" | "approved" | "rejected";
}
