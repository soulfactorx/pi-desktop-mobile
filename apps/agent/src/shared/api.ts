import type {
  PiResponse,
  SessionAttachResult,
  SessionEventNotification,
  SessionExitNotification,
  SessionSummary,
  SessionUiResolvedNotification,
  StoredSession,
  TrashItem,
  FsListDirResult,
} from "@pi-desktop/host-protocol/messages";
import type { SshHostConfig } from "@pi-desktop/host-deploy/types";

export type { SshHostConfig };
import type { TaskRecord } from "@pi-desktop/agent-kit/task-types";
import type { UsageRange, UsageSummary } from "@pi-desktop/agent-kit/usage-types";

export type { UsageRange, UsageSource, UsageSummary, UsageTotals } from "@pi-desktop/agent-kit/usage-types";
import type { Schedule } from "@pi-desktop/agent-kit/schedule-plan";
import type { ConnectionState } from "../vendor/shared/api";
import type { PiSetupView } from "./pi-setup";
import type { McpCheckResult, McpServerView } from "@pi-desktop/pi-isolation/mcp-presets";
import type { BulkAction, EntryInput, KnowledgeEntry, KnowledgeStats, ReviewItem } from "@pi-desktop/agent-kit/memory-types";
import type { SkillInput, SkillView } from "@pi-desktop/agent-kit/skill-types";
import type { AgentCard, CardDraft, NetworkState, PeerPolicy, PeerSettings } from "./network";

/**
 * 에이전트 앱의 main ↔ renderer IPC.
 *
 * Pi Desktop과 달리 호스트는 로컬 하나뿐이라 hostId를 주고받지 않는다 (원격은 Pi Desktop의 몫).
 */
export const IpcChannels = {
  connectionState: "agent:connection-state",
  defaultCwd: "agent:default-cwd",
  listHosts: "agent:list-hosts",
  currentHost: "agent:current-host",
  setHost: "agent:set-host",
  replaceAgent: "agent:replace-agent",
  listSshHosts: "agent:list-ssh-hosts",
  saveSshHost: "agent:save-ssh-host",
  removeSshHost: "agent:remove-ssh-host",
  listDir: "agent:list-dir",
  makeDir: "agent:make-dir",
  pickDirectory: "agent:pick-directory",
  pickFiles: "agent:pick-files",
  readImages: "agent:read-images",
  listTasks: "agent:list-tasks",
  listSchedules: "agent:list-schedules",
  setScheduleEnabled: "agent:set-schedule-enabled",
  removeSchedule: "agent:remove-schedule",
  piSetup: "agent:pi-setup",
  openPiDesktop: "agent:open-pi-desktop",
  installPiDesktop: "agent:install-pi-desktop",
  listSessions: "agent:list-sessions",
  closeSession: "agent:close-session",
  updateState: "agent:update-state",
  checkForUpdates: "agent:check-for-updates",
  confirmUpdate: "agent:confirm-update",
  kbList: "agent:kb-list",
  skillsList: "agent:skills-list",
  skillSave: "agent:skill-save",
  skillDelete: "agent:skill-delete",
  skillOpenFolder: "agent:skill-open-folder",
  kbSave: "agent:kb-save",
  kbBulk: "agent:kb-bulk",
  kbMerge: "agent:kb-merge",
  kbReviewed: "agent:kb-reviewed",
  kbReview: "agent:kb-review",
  kbStats: "agent:kb-stats",
  kbPreview: "agent:kb-preview",
  kbExport: "agent:kb-export",
  getAutoLearn: "agent:get-auto-learn",
  getElevation: "agent:get-elevation",
  setElevation: "agent:set-elevation",
  setAutoLearn: "agent:set-auto-learn",
  listRules: "agent:list-rules",
  removeRule: "agent:remove-rule",
  listAudit: "agent:list-audit",
  usageSummary: "agent:usage-summary",
  listMcp: "agent:list-mcp",
  addMcpPreset: "agent:add-mcp-preset",
  setMcpEnabled: "agent:set-mcp-enabled",
  removeMcp: "agent:remove-mcp",
  checkMcp: "agent:check-mcp",
  networkState: "agent:network-state",
  setNetworkSettings: "agent:set-network-settings",
  saveCard: "agent:save-card",
  previewPeer: "agent:preview-peer",
  pairWith: "agent:pair-with",
  checkPairings: "agent:check-pairings",
  approvePairing: "agent:approve-pairing",
  rejectPairing: "agent:reject-pairing",
  forgetPeer: "agent:forget-peer",
  setPeerPolicy: "agent:set-peer-policy",
  approvePeerTask: "agent:approve-peer-task",
  suggestCard: "agent:suggest-card",
  rejectPeerTask: "agent:reject-peer-task",
  openMcpFile: "agent:open-mcp-file",
  openSession: "agent:open-session",
  listHistory: "agent:list-history",
  searchHistory: "agent:search-history",
  deleteChat: "agent:delete-chat",
  setArchived: "agent:set-archived",
  listTrash: "agent:list-trash",
  restoreTrash: "agent:restore-trash",
  emptyTrash: "agent:empty-trash",
  attachSession: "agent:attach-session",
  sendCommand: "agent:send-command",
  sendRecord: "agent:send-record",
  // main → renderer 알림
  connectionChanged: "agent:connection-changed",
  sessionEvent: "agent:session-event",
  sessionExit: "agent:session-exit",
  uiResolved: "agent:ui-resolved",
  tasksChanged: "agent:tasks-changed",
  installProgress: "agent:install-progress",
  updateStateChanged: "agent:update-state-changed",
  menuCommand: "agent:menu-command",
} as const;

export type { ConnectionState, PiSetupView, Schedule, TaskRecord };

/** attach 결과. attach 도중 알림으로 온 이벤트도 함께 담는다 (Pi Desktop의 AttachResult와 같음) */
export interface AttachResult extends SessionAttachResult {
  events: SessionEventNotification[];
}

/** 자동 업데이트 상태 (Pi Desktop Mate와 같은 모양) */
export interface UpdateState {
  /** disabled: 개발·로컬 빌드, idle, checking, none: 최신, available, downloading, downloaded: 다시 시작하면 설치, error */
  status: "disabled" | "idle" | "checking" | "none" | "available" | "downloading" | "downloaded" | "error";
  current: string;
  /** auto: 내려받아 설치(Windows·AppImage), notify: 알리기만(서명 없는 macOS·deb) */
  mode: "auto" | "notify";
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

/** 사이드바의 대화 하나: 데몬 세션 요약 + Pi 세션 이름 (set_session_name) */
export type ChatSummary = SessionSummary & { name?: string };

/** Pi가 디스크에 남긴 지난 대화 하나 (데몬 session.history의 StoredSession) */
export type StoredChat = StoredSession;

/** 고를 수 있는 호스트 (설계 DESIGN-APPS.md §6 D3) */
export interface HostView {
  id: string;
  kind: "local" | "wsl" | "ssh";
  label: string;
}

/** 지금 쓰는 호스트. remote면 데몬을 거치지 않는 화면(기억·작업 등)은 아직 이 PC의 것만 보인다 (D4) */
export interface CurrentHost {
  id: string;
  remote: boolean;
}

/** 메시지와 함께 보낼 이미지 하나 */
export interface ImageAttachment {
  name: string;
  mimeType: string;
  /** base64. 읽지 못했으면 없고 error가 있다 */
  data?: string;
  error?: string;
}

/** 지난 대화 본문 검색 결과 */
export interface HistoryHit {
  path: string;
  snippet: string;
}

/** 새 세션 대신 이어 열 곳: 그 세션 파일을 그대로(sessionFile), 또는 거기서 분기해서(forkFrom) */
export type SessionSource = { sessionFile: string } | { forkFrom: string };

/** 승인 규칙 (agent-kit permissions/rules의 Rule) */
export interface RuleView {
  toolName: string;
  pattern: string;
  action: "allow" | "deny";
}

/** 감사 기록 한 줄 (agent-kit permissions/store의 AuditRecord) */
export interface AuditView {
  at: string;
  toolName: string;
  target: string;
  decision: string;
  cwd: string;
}

export interface AgentApi {
  connectionState(): Promise<ConnectionState>;
  /** 처음 열 작업 폴더 (사용자 홈) */
  defaultCwd(): Promise<string>;
  /** 호스트 목록 (로컬, WSL 배포판, 등록한 SSH 호스트) */
  listHosts(): Promise<HostView[]>;
  currentHost(): Promise<CurrentHost>;
  /** 호스트를 바꾼다. 다시 연결하고 화면을 새로 읽는다 */
  setHost(hostId: string): Promise<void>;
  /** 예전 Host Agent(업데이트 대기)를 지금 끄고 새 것으로 바꾼다. 돌고 있는 대화도 끝난다 */
  replaceAgent(): Promise<void>;
  listSshHosts(): Promise<SshHostConfig[]>;
  saveSshHost(host: SshHostConfig, previousName?: string): Promise<SshHostConfig>;
  removeSshHost(name: string): Promise<void>;
  /** 호스트의 폴더를 데몬으로 훑는다 (원격 호스트의 폴더 고르기). hostId는 vendor FolderBrowser와 맞춘 자리 */
  listDir(hostId: string, path?: string): Promise<FsListDirResult>;
  makeDir(hostId: string, parent: string, name: string): Promise<string>;
  pickDirectory(): Promise<string | undefined>;
  /** 첨부할 파일을 고른다 (여러 개). 취소하면 빈 배열 */
  pickFiles(): Promise<string[]>;
  /** 이미지 파일을 base64로 읽는다 (크기 상한을 넘거나 읽지 못한 것은 error) */
  readImages(paths: string[]): Promise<ImageAttachment[]>;
  /** 최근 작업 (대화에서 맡긴 것·예약 실행). 최근 것부터 */
  listTasks(): Promise<TaskRecord[]>;
  listSchedules(): Promise<Schedule[]>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<void>;
  removeSchedule(id: string): Promise<void>;
  /** Pi 준비 상태 (Pi·Node·모델·Git Bash·Pi Desktop) */
  piSetup(): Promise<PiSetupView>;
  /** 설치된 Pi Desktop을 연다. 없으면 false */
  openPiDesktop(): Promise<boolean>;
  /** Pi Desktop 최신 설치 파일을 내려받아 연다 (확인 창을 띄움) */
  installPiDesktop(): Promise<{ status: "opened" | "cancelled" | "page" }>;
  /** 데몬에서 돌고 있는 대화 세션과 그 이름 (스케줄러 세션은 뺀다) */
  listSessions(): Promise<ChatSummary[]>;
  closeSession(sessionId: string): Promise<void>;
  updateState(): Promise<UpdateState>;
  /** interactive면 결과를 창으로 알리고, 새 버전이 있으면 업데이트할지 묻는다 */
  checkForUpdates(interactive?: boolean): Promise<UpdateState>;
  /** 찾은 새 버전을 받을지 묻는다 (사이드바 배지) */
  confirmUpdate(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** 앱 메뉴바에서 고른 명령 (app-menu.ts의 MenuCommand) */
  onMenuCommand(listener: (id: string) => void): () => void;
  /** Pi 스킬 (사용자 스킬 폴더 + ~/.agents/skills) */
  skillsList(): Promise<SkillView[]>;
  /** 사용자 스킬을 만들거나(previous 없음) 고친다 */
  skillSave(previous: string | undefined, input: SkillInput): Promise<void>;
  skillDelete(name: string): Promise<void>;
  skillOpenFolder(): Promise<void>;
  /** 지식베이스 항목 (보관한 것 포함 여부) */
  kbList(includeArchived: boolean): Promise<KnowledgeEntry[]>;
  /** 새로 쓰거나(id 없음) 고친다 */
  kbSave(id: string | undefined, input: EntryInput): Promise<KnowledgeEntry>;
  kbBulk(ids: string[], action: BulkAction, tag?: string): Promise<number>;
  kbMerge(keepId: string, dropIds: string[]): Promise<void>;
  kbReviewed(id: string): Promise<void>;
  /** 점검 대기함 */
  kbReview(): Promise<ReviewItem[]>;
  kbStats(): Promise<KnowledgeStats>;
  /** 이 요청이면 프롬프트에 무엇이 실리는지 (회상 기록은 남기지 않는다) */
  kbPreview(prompt: string): Promise<{ text: string; chars: number; injected: number }>;
  /** Markdown 한 파일로 내보낸다. 저장한 경로 (취소하면 undefined) */
  kbExport(): Promise<string | undefined>;
  /** 대화가 끝난 뒤 자동으로 기억을 뽑는가 */
  getAutoLearn(): Promise<boolean>;
  setAutoLearn(on: boolean): Promise<void>;
  /** 관리자 권한 실행(shell_exec_elevated)을 켰는가 */
  getElevation(): Promise<boolean>;
  setElevation(on: boolean): Promise<void>;
  listRules(): Promise<RuleView[]>;
  removeRule(rule: RuleView): Promise<void>;
  listAudit(): Promise<AuditView[]>;
  /** 기간의 사용량 (Pi 세션 파일 + 세션 밖 호출) */
  usageSummary(range: UsageRange): Promise<UsageSummary>;
  /** Pi 사용자 MCP 설정(mcp.json)의 서버들 */
  listMcp(): Promise<McpServerView[]>;
  /** 미리 정한 웹 검색 서버를 넣는다 (키가 필요하면 key) */
  addMcpPreset(id: string, key?: string): Promise<McpServerView[]>;
  setMcpEnabled(name: string, enabled: boolean): Promise<McpServerView[]>;
  removeMcp(name: string): Promise<McpServerView[]>;
  /** pi mcp list로 연결을 확인한다 */
  checkMcp(): Promise<McpCheckResult>;
  /** 에이전트 네트워크 (피어) */
  networkState(): Promise<NetworkState>;
  setNetworkSettings(settings: PeerSettings): Promise<void>;
  saveCard(card: CardDraft): Promise<void>;
  /** 상대 주소로 카드를 받아 본다 */
  previewPeer(address: string): Promise<AgentCard>;
  pairWith(address: string): Promise<void>;
  /** 보낸 페어링 요청의 결과를 가져온다 (새로 맺어진 피어 이름) */
  checkPairings(): Promise<string[]>;
  approvePairing(requestId: string): Promise<void>;
  rejectPairing(requestId: string): Promise<void>;
  forgetPeer(id: string): Promise<void>;
  setPeerPolicy(id: string, policy: PeerPolicy): Promise<void>;
  /** 피어가 맡긴 작업을 그 폴더에서 하도록 승인한다 (스케줄러가 곧 시작) */
  approvePeerTask(id: string, cwd: string): Promise<void>;
  rejectPeerTask(id: string): Promise<void>;
  /** 기억(사실·교훈)과 대화 이름으로 카드 소개·잘하는 것 초안을 만든다 (저장하지 않음) */
  suggestCard(current: CardDraft): Promise<Pick<CardDraft, "description" | "skills">>;
  openMcpFile(): Promise<void>;
  /** agent-kit 확장을 올린 새 Pi 세션을 연다 */
  /** 새 세션을 연다. forkFrom(세션 파일)을 주면 그 대화를 이어 가는 분기 세션으로 연다 */
  openSession(cwd: string, from?: SessionSource): Promise<SessionSummary>;
  /** 지난 대화 (최근 순, 스케줄러 세션 제외) */
  listHistory(): Promise<StoredChat[]>;
  /** 지난 대화의 본문까지 찾는다 */
  searchHistory(query: string): Promise<HistoryHit[]>;
  /** 지난 대화를 휴지통으로 옮긴다 (열려 있으면 먼저 닫아야 한다) */
  deleteChat(path: string): Promise<void>;
  /** 지난 대화를 아카이브하거나 되돌린다 (파일은 그대로, 목록에서만 숨김) */
  setArchived(path: string, archived: boolean): Promise<void>;
  /** 휴지통 목록 */
  listTrash(): Promise<TrashItem[]>;
  /** 휴지통의 대화를 원래 자리로 되살린다 */
  restoreTrash(id: string): Promise<void>;
  /** 휴지통을 비운다 (ids가 없으면 전부). 정말 지운 개수 */
  emptyTrash(ids?: string[]): Promise<number>;
  attachSession(sessionId: string, lastSeq: number): Promise<AttachResult>;
  /** 응답을 기다리는 Pi RPC 명령 (prompt, abort, get_commands …) */
  sendCommand(sessionId: string, command: Record<string, unknown>): Promise<PiResponse>;
  /** 응답이 없는 레코드 (extension_ui_response) */
  sendRecord(sessionId: string, record: Record<string, unknown>): Promise<void>;
  onConnection(listener: (state: ConnectionState) => void): () => void;
  onSessionEvent(listener: (notification: SessionEventNotification) => void): () => void;
  onSessionExit(listener: (notification: SessionExitNotification) => void): () => void;
  onUiResolved(listener: (notification: SessionUiResolvedNotification) => void): () => void;
  /** 작업 기록이 바뀌었다 (새 작업·끝난 작업) */
  onTasksChanged(listener: () => void): () => void;
  onInstallProgress(listener: (received: number, total: number) => void): () => void;
}
