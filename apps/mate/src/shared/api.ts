import type { ChatLine, InboxItem } from "@pi-desktop/mate-kit/shared";
import type {
  ActivityRecord,
  Duty,
  InboxStatus,
  MateConfig,
  MateTrashItem,
  ProjectSnapshot,
  RunnerState,
  RunRecord,
  RunStatus,
} from "@pi-desktop/mate-runner/types";
import type { PiReadiness } from "@pi-desktop/mate-runner/pi-readiness";
import type { ChatView, DutyDraft, DutyView, InboxView, ObserveView, Overview, RunnerView, TranscriptItem } from "@pi-desktop/mate-runner/view-types";

export type { ChatView, DutyDraft, DutyView, InboxView, ObserveView, Overview, RunnerView, TranscriptItem };
import type { SkillInput, SkillView } from "@pi-desktop/agent-kit/skill-types";
import type { McpCheckResult, McpServerView } from "@pi-desktop/pi-isolation/mcp-presets";
import type { AppId, Importables, PackageResult, PackageView } from "@pi-desktop/pi-resources/types";
import type { SshHostConfig } from "@pi-desktop/host-deploy/types";
import type { FsListDirResult } from "@pi-desktop/host-protocol/messages";

export type { FsListDirResult, SshHostConfig };

/** 고를 수 있는 호스트 (DESIGN-MATE-REMOTE.md §3.1) */
/** 대화에 붙이는 이미지 (base64, data: 머리 없이) */
export interface ChatImage {
  name: string;
  mimeType: string;
  data: string;
}

export interface HostView {
  id: string;
  kind: "local" | "wsl" | "ssh";
  label: string;
}

/** 지금 호스트. 원격이면 실행기가 붙은 뒤 그 호스트의 Mate 홈·사용자 홈이 채워진다 */
export interface CurrentHost {
  id: string;
  remote: boolean;
  home?: string;
  userHome?: string;
}

export type { McpCheckResult, McpServerView, SkillInput, SkillView };

export type { PiReadiness };

/** Pi 준비 상태 + 설치된 Pi Desktop 위치 */
export interface PiSetupView extends PiReadiness {
  piDesktopPath?: string;
  checkedAt: number;
}

export type { ActivityRecord, ChatLine, Duty, InboxItem, InboxStatus, MateConfig, MateTrashItem, ProjectSnapshot, RunRecord, RunStatus };

export const IpcChannels = {
  overview: "mate:overview",
  saveDuty: "mate:save-duty",
  deleteDuty: "mate:delete-duty",
  deleteRun: "mate:delete-run",
  clearChat: "mate:clear-chat",
  restoreTrash: "mate:restore-trash",
  emptyTrash: "mate:empty-trash",
  runNow: "mate:run-now",
  setInbox: "mate:set-inbox",
  saveConfig: "mate:save-config",
  pickDirectory: "mate:pick-directory",
  restartRunner: "mate:restart-runner",
  revealHome: "mate:reveal-home",
  readSession: "mate:read-session",
  applyChange: "mate:apply-change",
  delegate: "mate:delegate",
  discardChange: "mate:discard-change",
  getAutostart: "mate:get-autostart",
  setAutostart: "mate:set-autostart",
  piReadiness: "mate:pi-readiness",
  installPiDesktop: "mate:install-pi-desktop",
  openPiDesktop: "mate:open-pi-desktop",
  installProgress: "mate:install-progress",
  updateState: "mate:update-state",
  updateStateChanged: "mate:update-state-changed",
  checkForUpdates: "mate:check-for-updates",
  confirmUpdate: "mate:confirm-update",
  telegramView: "mate:telegram-view",
  telegramSetToken: "mate:telegram-set-token",
  telegramRemove: "mate:telegram-remove",
  telegramPair: "mate:telegram-pair",
  telegramUnpair: "mate:telegram-unpair",
  telegramTest: "mate:telegram-test",
  chatSend: "mate:chat-send",
  listHosts: "mate:list-hosts",
  currentHost: "mate:current-host",
  setHost: "mate:set-host",
  listSshHosts: "mate:list-ssh-hosts",
  saveSshHost: "mate:save-ssh-host",
  removeSshHost: "mate:remove-ssh-host",
  listDir: "mate:list-dir",
  makeDir: "mate:make-dir",
  applyInstall: "mate:apply-install",
  describeInstall: "mate:describe-install",
  skillsList: "mate:skills-list",
  skillSave: "mate:skill-save",
  skillDelete: "mate:skill-delete",
  skillOpenFolder: "mate:skill-open-folder",
  listMcp: "mate:list-mcp",
  addMcpPreset: "mate:add-mcp-preset",
  setMcpEnabled: "mate:set-mcp-enabled",
  removeMcp: "mate:remove-mcp",
  mcpReadText: "mate:mcp-read-text",
  mcpWriteText: "mate:mcp-write-text",
  checkMcp: "mate:check-mcp",
  packagesList: "mate:packages-list",
  packageInstall: "mate:package-install",
  packageRemove: "mate:package-remove",
  importList: "mate:import-list",
  importSkill: "mate:import-skill",
  changed: "mate:changed",
} as const;


/** Mate 자동 업데이트 상태 (Pi Desktop과 같은 모양) */
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

/** 휴대폰(텔레그램) 연결 상태 */
export interface TelegramView {
  hasToken: boolean;
  botName?: string;
  tokenHint?: string;
  paired: boolean;
  chatName?: string;
  /** 지금 쓸 수 있는 연결 코드 */
  pairingCode?: string;
  pairingExpires?: number;
  lastPollAt?: number;
  lastError?: string;
  /** OS 키체인을 쓸 수 있는지 (없으면 토큰을 저장할 수 없음) */
  keychain: boolean;
}

export interface AutostartView {
  supported: boolean;
  enabled: boolean;
  reason?: string;
}








export interface MateApi {
  overview(): Promise<Overview>;
  saveDuty(draft: DutyDraft): Promise<Duty>;
  /** 임무를 휴지통으로 옮긴다 */
  deleteDuty(id: string): Promise<void>;
  /** 실행 기록을 세션 파일과 함께 휴지통으로 옮긴다 */
  deleteRun(id: string): Promise<void>;
  /** 대화 기록을 휴지통으로 옮긴다 (다음 말부터 새 대화). 지울 것이 없었으면 false */
  clearChat(): Promise<boolean>;
  /** 휴지통 항목을 원래 자리로 되살린다 */
  restoreTrash(id: string): Promise<void>;
  /** 휴지통을 비운다 (ids가 없으면 전부). 정말 지운 항목 수 */
  emptyTrash(ids?: string[]): Promise<number>;
  /** Mate가 제안한 설치(스킬 초안·MCP 서버·다른 앱 스킬 복사)를 적용한다. 사용자에게 보일 한 줄을 돌려준다 */
  applyInstall(itemId: string): Promise<string>;
  /** 설치 제안을 적용하기 전에 보일 내용 (Markdown) */
  describeInstall(itemId: string): Promise<string>;
  /** 호스트 목록 (로컬, WSL 배포판, 등록한 SSH 호스트) */
  listHosts(): Promise<HostView[]>;
  currentHost(): Promise<CurrentHost>;
  /** 호스트를 바꾼다. stopPrevious면 앞 호스트의 실행기를 멈춘다. 다시 붙고 화면을 새로 읽는다 */
  setHost(hostId: string, stopPrevious: boolean): Promise<void>;
  listSshHosts(): Promise<SshHostConfig[]>;
  saveSshHost(host: SshHostConfig, previousName?: string): Promise<SshHostConfig>;
  removeSshHost(name: string): Promise<void>;
  /** 그 호스트의 폴더를 실행기로 훑는다 (원격 호스트의 폴더 고르기) */
  listDir(path?: string): Promise<FsListDirResult>;
  makeDir(parent: string, name: string): Promise<string>;
  /** Mate 홈 skills/의 스킬 (DESIGN-APPS.md §3.4) */
  skillsList(): Promise<SkillView[]>;
  /** 스킬을 만들거나 고친다. previous가 있으면 그 이름의 스킬을 고친다(이름 바꾸기 포함) */
  skillSave(previous: string | undefined, input: SkillInput): Promise<void>;
  /** 스킬을 휴지통으로 옮긴다 */
  skillDelete(name: string): Promise<void>;
  skillOpenFolder(): Promise<void>;
  /** Mate 홈 mcp.json의 서버 (키 값은 보내지 않는다) */
  listMcp(): Promise<McpServerView[]>;
  /** 미리 정한 서버를 넣는다. 키가 필요한 서버는 key를 env에 넣는다 */
  addMcpPreset(id: string, key?: string): Promise<McpServerView[]>;
  setMcpEnabled(name: string, enabled: boolean): Promise<McpServerView[]>;
  removeMcp(name: string): Promise<McpServerView[]>;
  /** mcp.json 원문 (없으면 빈 설정을 만든다). 앱 안에서 고친다 (웹·원격 호스트에서도) */
  mcpReadText(): Promise<{ path: string; text: string }>;
  /** 고친 mcp.json 원문을 저장한다. JSON이 틀리면 오류 */
  mcpWriteText(text: string): Promise<McpServerView[]>;
  /** 서버마다 연결해 보고 결과를 받는다 (pi mcp list) */
  checkMcp(): Promise<McpCheckResult>;
  /** Mate 홈에 설치한 Pi 패키지(확장) (DESIGN-APPS.md §3.5). 도구는 처음 쓸 때 허용을 묻는다 */
  packagesList(): Promise<PackageView[]>;
  packageInstall(source: string): Promise<PackageResult>;
  packageRemove(source: string): Promise<PackageResult>;
  /** 다른 앱(Pi Desktop·Agent)에서 가져올 수 있는 스킬·패키지 */
  importList(): Promise<Importables>;
  importSkill(from: AppId, name: string): Promise<void>;
  runNow(id: string): Promise<void>;
  setInbox(ids: string[], status: InboxStatus | undefined): Promise<void>;
  saveConfig(
    patch: Partial<Omit<MateConfig, "observe" | "telegram">> & {
      observe?: Partial<MateConfig["observe"]>;
      telegram?: Partial<MateConfig["telegram"]>;
    },
  ): Promise<MateConfig>;
  pickDirectory(): Promise<string | undefined>;
  restartRunner(): Promise<RunnerView>;
  revealHome(): Promise<void>;
  /** 실행 기록의 Pi 세션을 대화 형태로 읽는다 */
  readSession(runId: string): Promise<TranscriptItem[]>;
  /** act 변경을 내 작업 폴더에 적용한다 (커밋하지 않은 변경으로) */
  applyChange(itemId: string): Promise<void>;
  /** act 변경과 그 작업 공간을 버린다 */
  discardChange(itemId: string): Promise<void>;
  /** 제안의 맡길 일을 그 폴더에서 바로 실행한다 (git 저장소면 고치기) */
  delegate(itemId: string): Promise<void>;
  /** 로그인할 때 실행기 시작 (설치본만) */
  getAutostart(): Promise<AutostartView>;
  setAutostart(enabled: boolean): Promise<AutostartView>;
  /** Pi 준비 상태 (설치·로그인·모델). refresh면 캐시를 버리고 다시 확인 */
  piReadiness(refresh?: boolean): Promise<PiSetupView>;
  /** Pi Desktop을 내려받아 설치 프로그램을 연다 */
  installPiDesktop(): Promise<{ status: "opened" | "cancelled" | "page"; path?: string }>;
  /** 설치된 Pi Desktop을 연다. 없으면 false */
  openPiDesktop(): Promise<boolean>;
  onInstallProgress(listener: (received: number, total: number) => void): () => void;
  /** 자동 업데이트 */
  updateState(): Promise<UpdateState>;
  /** interactive면 결과를 창으로 알리고, 새 버전이 있으면 업데이트할지 묻는다 */
  checkForUpdates(interactive?: boolean): Promise<UpdateState>;
  /** 찾은 새 버전을 받을지 묻는다 (상단 배지) */
  confirmUpdate(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** 휴대폰(텔레그램) 연결 */
  telegramView(): Promise<TelegramView>;
  /** 봇 토큰을 확인하고 암호화해 저장한 뒤 실행기를 다시 띄운다 */
  telegramSetToken(token: string): Promise<TelegramView>;
  telegramRemove(): Promise<TelegramView>;
  /** 10분짜리 연결 코드를 만든다 */
  telegramPair(): Promise<TelegramView>;
  telegramUnpair(): Promise<TelegramView>;
  telegramTest(): Promise<void>;
  /**
   * Mate에게 말한다 ("/"로 시작하면 명령). answerTo는 Mate 질문에 답할 때 그 질문 줄 id.
   * images는 붙여넣거나 고른 이미지 (4장, 한 장 5MB까지)
   */
  chatSend(text: string, answerTo?: string, images?: ChatImage[]): Promise<void>;
  /** Mate 홈의 파일이 바뀌면 불린다. 해제 함수를 돌려준다 */
  onChanged(listener: () => void): () => void;
}
