/**
 * main ↔ renderer 사이의 IPC 계약.
 *
 * 렌더러는 Node·Electron API에 직접 접근하지 않는다(contextIsolation + sandbox).
 * preload가 이 인터페이스만 `window.piDesktop`으로 노출한다 (설계 §5.8).
 */
import type { UsageRange, UsageSummary } from "@pi-desktop/agent-kit/usage-types";
import type {
  AuthCheckResult,
  DataBackupResult,
  CustomProviderForm,
  ModelsFileView,
  ModelsProbeResult,
  FsListDirResult,
  ResourcesView,
  ProjectTrustInfo,
  ResourceFile,
  ResourceKind,
  ExtensionTemplate,
  PackageCreateParams,
  PackageCreateResult,
  MyPackageInfo,
  ResourceWriteResult,
  ResourceExportResult,
  ModelsExportResult,
  ModelsExportModelResult,
  PackageFilterChange,
  PackageResourceItem,
  SettingsReadResult,
  SettingsTarget,
  ResourceImportParams,
  ResourceImportResult,
  FsSearchResult,
  ProviderInfo,
  PiLatest,
  PiModelsResult,
  PiStatus,
  PiVersions,
  PiUpdateOutputNotification,
  PiUpdateResult,
  PiUpdateTarget,
  HostInfo,
  PiLocation,
  PiResponse,
  SessionAttachResult,
  SessionEventNotification,
  SessionExitNotification,
  SessionExternalWriteNotification,
  SessionWriterChangedNotification,
  FilesChangedNotification,
  PlaygroundOutputNotification,
  PlaygroundRunParams,
  PlaygroundRunResult,
  SessionSummary,
  SessionUiResolvedNotification,
  StoredChangedNotification,
  StoredDeleteResult,
  TrashItem,
  StoredInspectResult,
  StoredReadResult,
  StoredSession,
} from "@pi-desktop/host-protocol/messages";

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | {
      status: "connected";
      host: HostInfo;
      /**
       * 떠 있는 데몬이 앱의 번들보다 예전 것인데 Pi 세션이 돌고 있어 바꾸지 못했다 (설계 §3.4).
       * 세션이 모두 끝나면 앱이 알아서 바꾼다. liveSessions는 그때 실행 중이던 세션 수
       */
      agentUpdate?: { liveSessions: number };
    }
  | {
      status: "disconnected";
      reason: string;
      /** 다시 붙기를 시도하는 시각 (ms). 없으면 자동으로 다시 붙지 않는다 */
      retryAt?: number;
      /** 연달아 실패한 횟수와 자동으로 다시 붙는 최대 횟수 */
      failures?: number;
      maxRetries?: number;
      /** 연달아 실패해 자동으로 다시 붙기를 멈췄다. "다시 연결"(reconnectHost)로 다시 시작한다 */
      gaveUp?: boolean;
    };

/** Pi가 도는 곳 하나. 로컬 PC 또는 WSL 배포판 (SSH는 M3). */
export interface TerminalOpenRequest {
  hostId: string;
  kind: "pi" | "shell";
  /** 작업 폴더 (호스트 기준 경로) */
  cwd?: string;
  /** pi에 붙일 인자 (예: --session <파일>) */
  args?: string[];
  cols: number;
  rows: number;
}

export interface HostDescriptor {
  /** "local", "wsl:<배포판 이름>" 또는 "ssh:<이름>" */
  id: string;
  kind: "local" | "wsl" | "ssh";
  /** 화면 표시용 이름 */
  label: string;
}

/** 사용자가 등록한 SSH 호스트 (설계 §5.6). 인증 정보는 담지 않는다: 키와 ssh-agent에 맡긴다 */
export interface SshHostConfig {
  /** 화면에 보일 이름. 호스트 id("ssh:<이름>")에도 쓰여 겹칠 수 없다 */
  name: string;
  /** ssh에 넘기는 대상: user@host 또는 ~/.ssh/config의 Host 이름 */
  target: string;
  /** 비우면 ssh 기본값(22 또는 ~/.ssh/config) */
  port?: number;
}

/** Marketplace 검색 결과의 패키지 하나 (npm pi-package) */
export interface MarketPackage {
  name: string;
  version: string;
  description?: string;
  /** 마지막 게시 시각 (ms) */
  updated?: number;
  publisher?: string;
  monthlyDownloads?: number;
  repository?: string;
}

export interface MarketSearchResult {
  total: number;
  packages: MarketPackage[];
}

/** Marketplace 상세 (npm 패키지 문서에서 읽은 것) */
export interface MarketDetail {
  name: string;
  latest: string;
  description?: string;
  license?: string;
  repository?: string;
  readme: string;
  /** 최근 안정 버전부터 */
  versions: string[];
  updated?: number;
  /** declared: package.json의 pi 매니페스트, conventional: 관례 폴더로 찾음(미리 알 수 없음) */
  manifest: "declared" | "conventional";
  /** 매니페스트에 적힌 리소스 종류 */
  kinds: Array<"extensions" | "skills" | "prompts" | "themes">;
  /** 확장(임의 코드)을 실행할 수 있다. 매니페스트가 없으면 알 수 없어 true */
  mayRunCode: boolean;
  /** 함께 설치되는 의존성 이름 */
  dependencies: string[];
  /** npm이 설치할 때 실행하는 스크립트 (preinstall·install·postinstall) */
  installScripts: string[];
}

/** GitHub 저장소 (Marketplace GitHub 카탈로그) */
export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** 브랜치·태그. 없으면 기본 브랜치 */
  ref?: string;
}

export interface GithubFile {
  /** 스킬 폴더 기준 경로 (프롬프트는 저장소 기준) */
  path: string;
  /** git blob SHA (나중에 업데이트·로컬 수정 확인에 쓴다) */
  sha: string;
  size: number;
}

export interface GithubSkill {
  /** 폴더 이름. 가져올 때 기본 이름 */
  name: string;
  /** 저장소 안의 스킬 폴더 */
  dir: string;
  files: GithubFile[];
  size: number;
}

export interface GithubPrompt {
  name: string;
  path: string;
  sha: string;
  size: number;
}

/** 커밋에 고정해 훑은 저장소의 스킬·프롬프트 */
export interface GithubCatalog extends GithubRepoRef {
  /** 훑은 커밋 */
  sha: string;
  skills: GithubSkill[];
  prompts: GithubPrompt[];
  /** 저장소가 너무 커서 GitHub가 트리를 잘라 보냈다 */
  truncated: boolean;
}

export interface GithubImportRequest {
  hostId: string;
  /** 프로젝트 범위의 기준 폴더 */
  cwd: string;
  scope: "user" | "project";
  /** 가져와 쓸 이름 */
  name: string;
  repo: GithubRepoRef & { sha: string };
  item: { kind: "skill"; dir: string; files: GithubFile[] } | { kind: "prompt"; path: string; sha: string; size: number };
}

/** 가져온 스킬·프롬프트의 출처 기록 (앱 userData의 imports.json) */
export interface ImportRecord {
  hostId: string;
  kind: "skill" | "prompt";
  name: string;
  scope: "user" | "project";
  /** 가져온 곳 (호스트 기준): 스킬 폴더 또는 프롬프트 파일 */
  target: string;
  source: { owner: string; repo: string; sha: string; path: string };
  /** 가져온 파일과 git blob SHA (업데이트·로컬 수정 확인용) */
  files: Record<string, string>;
  importedAt: number;
}

/** 다른 호스트로 복사한 리소스 종류. context는 사용자 AGENTS.md·SYSTEM.md·APPEND_SYSTEM.md */
export type CopyKind = "skill" | "prompt" | "extension" | "context";

/** 다른 호스트로 복사한 기록 (설계 §5.9 "출처 기록", 앱 userData의 copies.json). 안내용이고 자동으로 반영하지 않는다 */
export interface CopyRecord {
  kind: CopyKind;
  name: string;
  fromHostId: string;
  /** 원본을 다시 읽을 경로 (리소스 목록의 경로: 스킬은 SKILL.md, 폴더 확장은 index 파일) */
  fromPath: string;
  toHostId: string;
  /** 대상에서 리소스 목록에 보일 경로 (같은 모양) */
  toPath: string;
  /** 복사한 파일과 git blob SHA */
  files: Record<string, string>;
  copiedAt: number;
}

/** 복사가 끝난 뒤 앱에 남길 내용. 해시는 앱이 계산한다 */
export interface CopyRecordInput extends Omit<CopyRecord, "files" | "copiedAt"> {
  files: Array<{ path: string; contentBase64: string }>;
}

/** 복사한 항목의 지금 상태 */
export interface CopyStatus {
  toPath: string;
  /** 이 호스트의 사본: same 복사한 그대로, modified 고침, missing 지워짐 */
  local: "same" | "modified" | "missing" | "unknown";
  /** 원본: same 그대로, changed 바뀜, gone 사라짐, unknown 확인 못함 (호스트 연결 안 됨 등) */
  source: "same" | "changed" | "gone" | "unknown";
  error?: string;
}

/** 호스트 비교에 쓰는 사용자 범위 리소스 하나 (설계 §5.9 "호스트 비교 화면") */
export interface InventoryItem {
  kind: CopyKind;
  /** 견줄 때 쓰는 이름 (스킬·확장은 폴더나 파일 이름, 프롬프트는 /이름, 컨텍스트는 파일 이름) */
  name: string;
  /** 리소스 목록의 경로 (호스트 기준) */
  path: string;
  /** 내용 해시. 파일 하나면 그 파일의 git blob SHA, 여럿이면 경로·SHA 목록의 SHA-1 */
  digest?: string;
  files: number;
  /** 읽지 못했으면 이유 */
  error?: string;
}

/** 한 호스트의 사용자 범위 리소스 목록 */
export interface HostInventory {
  hostId: string;
  agentDir: string;
  platform: string;
  items: InventoryItem[];
}

/** 앱 자동 업데이트 상태 (M5) */
export interface UpdateState {
  /**
   * disabled: 개발 실행, idle: 아직 확인 안 함, checking, none: 최신, available: 새 버전(알리기만 하는 곳),
   * downloading, downloaded: 다시 시작하면 설치, error
   */
  status: "disabled" | "idle" | "checking" | "none" | "available" | "downloading" | "downloaded" | "error";
  /** 지금 앱 버전 */
  current: string;
  /** auto: 내려받아 설치(Windows·AppImage), notify: 알리기만(서명 없는 macOS·deb) */
  mode: "auto" | "notify";
  /** 새 버전 */
  version?: string;
  percent?: number;
  /** 알리기만 하는 곳에서 열 릴리스 페이지 */
  url?: string;
  checkedAt?: number;
  error?: string;
}

/** 작업 기록 한 줄 (앱 userData의 activity-log.jsonl). 키 값·파일 내용은 담지 않는다 */
export interface ActionLogEntry {
  time: number;
  /** 작업한 호스트. 앱 설정(SSH 호스트 목록 등)은 "app" */
  hostId: string;
  summary: string;
  /** 터미널에서 실행한 명령 등 */
  detail?: string;
  ok: boolean;
  error?: string;
}

/** 가져온 항목의 지금 상태 */
export interface ImportStatus {
  target: string;
  /** same: 가져온 그대로, modified: 이 호스트에서 고침, missing: 지워짐 */
  local: "same" | "modified" | "missing";
  /** 고치거나 더하거나 지운 파일 */
  localChanged: string[];
  /** same: 원본 최신과 같음, changed: 원본이 바뀜, gone: 원본에서 사라짐, unknown: 확인 못함 */
  upstream: "same" | "changed" | "gone" | "unknown";
  /** 비교한 원본 커밋 */
  upstreamSha?: string;
  upstreamChanged: string[];
  /** 확인하지 못한 이유 (GitHub 한도 등) */
  error?: string;
}

/** 재생 이벤트를 함께 담은 attach 결과 */
export interface AttachResult extends SessionAttachResult {
  events: SessionEventNotification[];
}

export interface OpenSessionRequest {
  cwd: string;
  /** 이어서 열 Pi 세션 파일. 없으면 새 세션 */
  sessionFile?: string;
  /** 이 세션 파일에서 분기한 새 세션으로 연다 (다른 프로그램이 쓰는 세션을 이어 갈 때) */
  forkFrom?: string;
  /** 이번 실행에만 쓰는 프로젝트 신뢰 결정 (pi --approve / --no-approve) */
  trust?: "yes" | "no";
  /** 작업 폴더가 없으면 만들고 연다 (지워진 폴더의 세션을 같은 파일로 이어 쓸 때) */
  createCwd?: boolean;
}

export interface PiDesktopApi {
  /**
   * 화면을 띄운 곳. electron: 데스크톱 앱(OS 대화상자·탐색기를 쓸 수 있다),
   * web: 웹 서버(pi-web)를 브라우저로 연 것(서버의 폴더를 앱의 폴더 탐색 창으로 고른다).
   */
  readonly shell: "electron" | "web";
  /** 이 PC에서 쓸 수 있는 호스트 목록 */
  listHosts(): Promise<HostDescriptor[]>;
  listSshHosts(): Promise<SshHostConfig[]>;
  /** SSH 호스트를 추가하거나 고친다. previousName은 고치기 전 이름 */
  saveSshHost(host: SshHostConfig, previousName?: string): Promise<void>;
  removeSshHost(name: string): Promise<void>;
  /** 호스트 연결을 시작하고 현재 상태를 돌려준다 (이미 연결 중이면 그대로) */
  connectHost(hostId: string): Promise<ConnectionState>;
  /** 다시 붙기를 멈췄거나 기다리는 중인 호스트에 지금 다시 연결한다 */
  reconnectHost(hostId: string): Promise<void>;
  /** 예전 데몬을 지금 끄고 새 번들로 다시 띄운다. 실행 중인 Pi 세션도 끝난다 */
  replaceAgent(hostId: string): Promise<void>;
  locatePi(hostId: string): Promise<PiLocation>;
  listSessions(hostId: string): Promise<SessionSummary[]>;
  /** Pi가 디스크에 저장한 세션 기록. cwd를 주면 그 폴더의 세션만 */
  listHistory(hostId: string, cwd?: string): Promise<StoredSession[]>;
  /** 세션 파일 상태 (다른 프로그램이 쓰고 있는지 판단용) */
  inspectStored(hostId: string, path: string): Promise<StoredInspectResult>;
  /** 저장된 세션 파일을 지운다 (데몬 홈의 휴지통으로 옮김). 실행 중이면 먼저 닫아야 한다 */
  deleteStored(hostId: string, path: string): Promise<StoredDeleteResult>;
  /** 휴지통 목록 (예전 삭제가 남긴 백업도 함께) */
  listTrash(hostId: string): Promise<TrashItem[]>;
  /** 휴지통의 세션을 원래 자리로 되살리고 그 경로를 돌려준다 */
  restoreTrash(hostId: string, id: string): Promise<string>;
  /** 휴지통을 비운다 (ids가 없으면 전부). 정말 지운 개수 */
  emptyTrash(hostId: string, ids?: string[]): Promise<number>;
  /** 세션을 아카이브하거나 되돌린다 (파일은 그대로, 앱 목록에서만 숨김) */
  setArchived(hostId: string, path: string, archived: boolean): Promise<void>;
  /** 세션 파일을 읽기만 해서 현재 대화를 받는다 (팔로우 모드) */
  readStored(hostId: string, path: string): Promise<StoredReadResult>;
  /** 세션 파일 변경 감시 시작·해제 (팔로우 모드) */
  watchStored(hostId: string, path: string): Promise<void>;
  unwatchStored(hostId: string, path: string): Promise<void>;
  /** 파일·폴더 트리를 감시한다 (Extension Dev Mode). 같은 watchId로 다시 부르면 뿌리를 바꾼다 */
  watchTree(hostId: string, watchId: string, roots: string[]): Promise<void>;
  unwatchTree(hostId: string, watchId: string): Promise<void>;
  /** SDK Playground: 스크립트를 그 호스트의 Pi SDK로 실행한다. 끝날 때까지 기다리고 출력은 onPlaygroundOutput으로 */
  playgroundRun(hostId: string, params: PlaygroundRunParams): Promise<PlaygroundRunResult>;
  playgroundStop(hostId: string, runId: string): Promise<void>;
  /** 이 호스트의 Pi 세션 폴더에서 기간별 토큰·비용을 센다 (사용량 화면) */
  usageSummary(hostId: string, range: UsageRange): Promise<UsageSummary>;
  openSession(hostId: string, request: OpenSessionRequest): Promise<SessionSummary>;
  /**
   * 세션에 붙는다. 재생된 이벤트는 알림이 아니라 결과의 events로 함께 돌려준다.
   * (IPC 알림과 invoke 응답은 렌더러에 도착하는 순서가 보장되지 않기 때문)
   */
  attachSession(hostId: string, sessionId: string, lastSeq: number): Promise<AttachResult>;
  closeSession(hostId: string, sessionId: string): Promise<void>;
  /** 다른 프로그램의 끼어들기 표시를 지운다 ("무시하고 계속") */
  clearExternalWrite(hostId: string, sessionId: string): Promise<void>;
  /** 이 세션의 입력 권한을 가져온다. 가지고 있던 다른 앱은 읽기 전용이 된다 */
  claimWriter(hostId: string, sessionId: string): Promise<void>;
  /** Pi RPC 명령을 보내고 Pi의 응답을 받는다 */
  sendCommand(hostId: string, sessionId: string, command: Record<string, unknown>): Promise<PiResponse>;
  /** 응답이 없는 레코드를 Pi에 보낸다 (예: 확장 다이얼로그 응답 extension_ui_response) */
  sendRecord(hostId: string, sessionId: string, record: Record<string, unknown>): Promise<void>;
  /** 폴더 선택 대화상자 (로컬 호스트 전용) */
  pickDirectory(): Promise<string | undefined>;
  /**
   * 툴이 다룬 파일을 탐색기에서 보여준다 (파일을 실행하지 않도록 열지는 않고 위치만 보여준다).
   * 이 PC에서 열 수 없는 호스트면 false.
   */
  revealFile(hostId: string, cwd: string, path: string): Promise<boolean>;
  /** Pi Manager: 이 호스트의 Pi 설치·Node·데이터 상태 (읽기 전용) */
  piStatus(hostId: string): Promise<PiStatus>;
  /** Pi 데이터 폴더(~/.pi/agent)를 tar.gz로 백업 */
  dataBackup(hostId: string): Promise<DataBackupResult>;
  /** Pi 데이터 폴더 삭제. confirm은 pi.status로 받은 데이터 폴더 경로 (Pi를 제거한 뒤에만 된다) */
  dataDelete(hostId: string, confirm: string): Promise<void>;
  /** 배포된 Pi 버전 목록 (데몬이 1시간 캐시) */
  piVersions(hostId: string): Promise<PiVersions>;
  /** Pi 최신 버전 (데몬이 1시간 캐시, force면 다시 묻는다) */
  piLatest(hostId: string, force?: boolean): Promise<PiLatest>;
  /** 이 호스트의 Pi가 쓸 수 있는 모델 (pi --list-models). 설정 폼의 프로바이더·모델 선택지 */
  piModels(hostId: string): Promise<PiModelsResult>;
  /**
   * Pi 업데이트 (pi update). 끝날 때까지 기다린다. 진행 출력은 onPiUpdateOutput으로 taskId와 함께 온다.
   */
  piUpdate(hostId: string, target: PiUpdateTarget, taskId: string, force?: boolean): Promise<PiUpdateResult>;
  /** 프로바이더 목록과 저장된 자격 증명의 종류 (키 값은 오지 않는다) */
  authProviders(hostId: string): Promise<ProviderInfo[]>;
  /** pi auth check로 인증 상태 확인 */
  authCheck(hostId: string, provider: string): Promise<AuthCheckResult>;
  /** auth.json에 API 키 저장 */
  authSetApiKey(hostId: string, provider: string, key: string): Promise<void>;
  /** auth.json에서 자격 증명 삭제 */
  authRemove(hostId: string, provider: string): Promise<{ removed: boolean }>;
  /** models.json의 사용자 정의 프로바이더 (그대로 키 값은 가려져 온다) */
  modelsRead(hostId: string): Promise<ModelsFileView>;
  /** 사용자 정의 프로바이더 저장. previousId는 ID를 바꿀 때 원래 ID */
  modelsSaveProvider(hostId: string, provider: CustomProviderForm, previousId?: string): Promise<void>;
  modelsRemoveProvider(hostId: string, id: string): Promise<{ removed: boolean }>;
  /** 엔드포인트 연결 시험. apiKey가 없고 providerId가 있으면 저장된 키를 쓴다 */
  modelsProbe(hostId: string, baseUrl: string, apiKey?: string, providerId?: string): Promise<ModelsProbeResult>;
  /**
   * 내장 터미널을 연다 (설계 §4.12). kind "pi"는 그 호스트의 Pi TUI, "shell"은 셸.
   * 출력은 onTerminalData, 끝나면 onTerminalExit로 온다.
   */
  terminalOpen(request: TerminalOpenRequest): Promise<{ id: string; title: string }>;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalClose(id: string): void;
  onTerminalData(listener: (id: string, data: string) => void): () => void;
  onTerminalExit(listener: (id: string, exitCode: number) => void): () => void;
  /** 작업 폴더에서 파일을 찾는다 (입력창 @ 파일 피커). 경로는 작업 폴더 기준, 구분자 "/" */
  searchFiles(hostId: string, cwd: string, query: string): Promise<FsSearchResult>;
  /** 호스트의 한 폴더에 있는 하위 폴더 목록 (폴더 탐색 창). path가 없으면 홈 */
  /** 그 호스트에 새 폴더를 만든다 (parent가 비었으면 홈). 만든 폴더의 절대 경로 */
  makeDir(hostId: string, parent: string, name: string): Promise<string>;
  listDir(hostId: string, path?: string): Promise<FsListDirResult>;
  /** 작업 폴더에서 Pi가 불러오는 리소스 (읽기 전용) */
  listResources(hostId: string, cwd: string): Promise<ResourcesView>;
  /** npm에서 Pi 패키지를 찾는다 (이 PC가 조회) */
  marketSearch(query: string, from: number): Promise<MarketSearchResult>;
  marketDetail(name: string): Promise<MarketDetail>;
  /** GitHub 저장소를 커밋에 고정해 훑는다 (owner/repo[@ref] 또는 주소) */
  githubBrowse(spec: string): Promise<GithubCatalog>;
  /** 훑은 커밋의 파일 하나 (미리보기) */
  githubText(repo: GithubRepoRef & { sha: string }, path: string): Promise<string>;
  /** 저장소의 스킬 폴더나 프롬프트 하나를 그 호스트의 범위에 가져오고 출처를 기록한다 */
  githubImport(request: GithubImportRequest): Promise<ImportRecord>;
  /** 이 호스트로 가져온 기록 */
  listImports(hostId: string): Promise<ImportRecord[]>;
  /** 다른 호스트로 복사할 스킬 폴더·프롬프트·확장을 원본 호스트에서 읽는다 (설계 §5.9) */
  exportResource(hostId: string, kind: "skill" | "prompt" | "extension", path: string): Promise<ResourceExportResult>;
  /** 다른 호스트로 옮길 models.json 프로바이더 (그대로 키 값인 apiKey·헤더는 뺀다) */
  modelsExport(hostId: string, id: string): Promise<ModelsExportResult>;
  /** 다른 호스트로 옮길 모델 하나 (그대로 값인 헤더는 뺀다) */
  modelsExportModel(hostId: string, providerId: string, modelId: string): Promise<ModelsExportModelResult>;
  /** 받은 모델을 그 호스트의 같은 이름 프로바이더에 넣는다. replace면 같은 ID를 바꾼다 */
  modelsImportModel(hostId: string, providerId: string, model: Record<string, unknown>, replace: boolean): Promise<void>;
  /** 받은 프로바이더를 그 호스트의 models.json에 쓴다. replace면 이미 있는 것을 바꾼다 (대상 키는 남김) */
  modelsImport(hostId: string, id: string, provider: Record<string, unknown>, replace: boolean): Promise<void>;
  /** 설정에 적힌 패키지 하나가 내놓는 리소스와 켜짐 여부 */
  packageResources(hostId: string, cwd: string, source: string, scope: "user" | "project", overlay?: boolean): Promise<PackageResourceItem[]>;
  /** 패키지 리소스를 켜고 끈다 (그 범위 settings.json의 패키지 필터). reset이면 필터를 먼저 지운다 */
  setPackageFilter(
    hostId: string,
    cwd: string,
    source: string,
    scope: "user" | "project",
    changes: PackageFilterChange[],
    reset: boolean,
    /** 종류별 배열을 통째로 적는다 (설치할 때 종류 빼기, 다른 호스트의 필터 옮기기) */
    set?: Partial<Record<"extensions" | "skills" | "prompts" | "themes", string[]>>,
    /** 사용자 패키지를 이 프로젝트(cwd)에서만 고른다 (프로젝트 settings의 autoload: false 항목) */
    overlay?: boolean,
  ): Promise<void>;
  /** 그 호스트의 settings.json (target이 없으면 사용자 범위) */
  settingsRead(hostId: string, target?: SettingsTarget): Promise<SettingsReadResult>;
  /** settings.json 원본 글을 쓴다 (JSON 편집). 읽은 뒤 바뀌었으면 거부. baseMtime null은 새 파일 */
  settingsWrite(hostId: string, content: string, baseMtime: number | null, target?: SettingsTarget): Promise<{ mtimeMs: number }>;
  /** 그 호스트의 사용자 settings.json에서 받은 최상위 키만 바꾸고 remove의 키는 지운다 (설계 §4.8·§5.9) */
  settingsMerge(hostId: string, values: Record<string, unknown>, remove?: string[], target?: SettingsTarget): Promise<void>;
  /** 그 호스트에 설치된 Pi의 settings.json JSON Schema. 없는 Pi면 null */
  settingsSchema(hostId: string): Promise<Record<string, unknown> | null>;
  /** 받은 스킬·프롬프트 파일을 그 호스트의 범위에 쓴다 (replace면 이전 것을 백업하고 바꾼다) */
  importResourceFiles(hostId: string, params: ResourceImportParams): Promise<ResourceImportResult>;
  /** 가져온 항목들의 로컬 수정·원본 업데이트를 확인한다 (저장소마다 GitHub를 한 번씩 조회) */
  importStatus(hostId: string): Promise<ImportStatus[]>;
  /** 다른 호스트로 복사한 기록을 남긴다 (같은 대상 위치는 바꾼다) */
  recordCopy(input: CopyRecordInput): Promise<void>;
  /** 앱 자동 업데이트 상태와 조작 (M5) */
  updateState(): Promise<UpdateState>;
  /** 업데이트를 확인한다. interactive면 결과를 창으로 알리고, 새 버전이 있으면 업데이트할지 묻는다 */
  checkForUpdates(interactive?: boolean): Promise<UpdateState>;
  /** 찾은 새 버전을 받을지 묻고, 고르면 내려받는다 (알리기만 하는 곳은 릴리스 페이지를 연다) */
  confirmUpdate(): Promise<void>;
  /** 내려받은 업데이트를 설치하며 다시 시작한다 */
  installUpdate(): Promise<void>;
  /** 새 버전의 릴리스 페이지를 연다 (알리기만 하는 곳) */
  openRelease(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** 메뉴바에서 고른 명령 id (app-menu.ts) */
  onMenuCommand(listener: (id: string) => void): () => void;
  /** 작업 기록 (최근 것부터) */
  listActionLog(limit?: number): Promise<ActionLogEntry[]>;
  /** 화면에서 시작한 작업을 기록에 남긴다 (터미널에서 실행한 설치·제거 명령 등) */
  logAction(entry: { hostId: string; summary: string; detail?: string }): Promise<void>;
  /** 호스트 비교용: 그 호스트의 사용자 범위 스킬·프롬프트·확장·AGENTS.md 등과 내용 해시 */
  hostInventory(hostId: string): Promise<HostInventory>;
  /** 이 호스트로 복사해 온 항목들의 기록과, 그 뒤 사본·원본이 바뀌었는지 */
  copyStatus(hostId: string): Promise<Array<{ record: CopyRecord; status: CopyStatus }>>;
  /** 원본 최신 커밋으로 바꾼다. 이전 내용은 그 호스트의 백업 폴더로 옮겨진다 */
  importUpdate(hostId: string, target: string): Promise<ImportRecord>;
  /** 가져온 항목을 백업 폴더로 옮기고 기록을 지운다 */
  importRemove(hostId: string, target: string): Promise<void>;
  /** 파일 하나의 로컬 내용과 원본(upstreamSha) 내용 */
  importDiff(hostId: string, target: string, path: string, upstreamSha: string): Promise<{ local: string; upstream: string }>;
  /** 작업 폴더의 프로젝트 신뢰 상태 */
  getTrust(hostId: string, cwd: string): Promise<ProjectTrustInfo>;
  /** 프로젝트 신뢰 결정을 Pi의 trust.json에 저장한다 (null이면 지운다) */
  setTrust(hostId: string, cwd: string, decision: boolean | null): Promise<ProjectTrustInfo>;
  /** 리소스 마크다운 파일 (데이터 폴더·.pi/·AGENTS.md만). cwd는 프로젝트 리소스 위치 기준 */
  readResource(hostId: string, cwd: string, path: string): Promise<ResourceFile>;
  /** baseMtime: 읽었을 때의 수정 시각. 그 뒤 바뀌었으면 거부된다. 없으면 새 파일이어야 한다 */
  writeResource(hostId: string, cwd: string, path: string, content: string, baseMtime?: number): Promise<ResourceWriteResult>;
  createResource(hostId: string, cwd: string, kind: ResourceKind, scope: "user" | "project", name: string, template?: ExtensionTemplate): Promise<ResourceFile>;
  /** ~/pi-packages/<이름>에 새 Pi 패키지를 만든다 */
  createPackage(hostId: string, params: PackageCreateParams): Promise<PackageCreateResult>;
  /** ~/pi-packages의 내 패키지 목록 */
  listMyPackages(hostId: string): Promise<MyPackageInfo[]>;
  /** 내 패키지를 지운다 (백업 폴더로 옮기고 그 위치를 돌려준다) */
  deleteMyPackage(hostId: string, folder: string): Promise<{ backup: string }>;
  /** 프롬프트·스킬·확장을 지운다. 바로 지우지 않고 백업 폴더로 옮기며 그 위치를 돌려준다 */
  deleteResource(hostId: string, path: string, kind: "prompt" | "skill" | "extension"): Promise<{ backup: string }>;

  onConnection(listener: (hostId: string, state: ConnectionState) => void): () => void;
  onSessionEvent(listener: (hostId: string, notification: SessionEventNotification) => void): () => void;
  onSessionExit(listener: (hostId: string, notification: SessionExitNotification) => void): () => void;
  /** 확장 다이얼로그가 처리되었다 (다른 창에서 답했거나 제한 시간이 지남) */
  onUiResolved(listener: (hostId: string, notification: SessionUiResolvedNotification) => void): () => void;
  /** 감시 중인 세션 파일이 바뀌었다 */
  onStoredChanged(listener: (hostId: string, notification: StoredChangedNotification) => void): () => void;
  /** 이 앱의 Pi가 쓰는 세션 파일에 다른 프로그램이 쓴 것이 감지되었다 */
  onExternalWrite(listener: (hostId: string, notification: SessionExternalWriteNotification) => void): () => void;
  onWriterChanged(listener: (hostId: string, notification: SessionWriterChangedNotification) => void): () => void;
  /** watchTree로 감시하는 파일이 바뀌었다 */
  onFilesChanged(listener: (hostId: string, notification: FilesChangedNotification) => void): () => void;
  onPlaygroundOutput(listener: (hostId: string, notification: PlaygroundOutputNotification) => void): () => void;
  onPiUpdateOutput(listener: (hostId: string, notification: PiUpdateOutputNotification) => void): () => void;
}

/** IPC 채널 이름. invoke(요청/응답)와 send(main → renderer 알림)를 구분한다. */
export const IpcChannels = {
  listHosts: "pi:list-hosts",
  connectHost: "pi:connect-host",
  reconnectHost: "pi:reconnect-host",
  listSshHosts: "pi:list-ssh-hosts",
  saveSshHost: "pi:save-ssh-host",
  removeSshHost: "pi:remove-ssh-host",
  replaceAgent: "pi:replace-agent",
  locatePi: "pi:locate",
  listSessions: "pi:list-sessions",
  openSession: "pi:open-session",
  listHistory: "pi:list-history",
  inspectStored: "pi:inspect-stored",
  deleteStored: "pi:delete-stored",
  listTrash: "pi:list-trash",
  restoreTrash: "pi:restore-trash",
  emptyTrash: "pi:empty-trash",
  setArchived: "pi:set-archived",
  readStored: "pi:read-stored",
  watchStored: "pi:watch-stored",
  unwatchStored: "pi:unwatch-stored",
  watchTree: "pi:watch-tree",
  unwatchTree: "pi:unwatch-tree",
  playgroundRun: "pi:playground-run",
  playgroundStop: "pi:playground-stop",
  usageSummary: "pi:usage-summary",
  attachSession: "pi:attach-session",
  closeSession: "pi:close-session",
  clearExternalWrite: "pi:clear-external-write",
  claimWriter: "pi:claim-writer",
  sendCommand: "pi:send-command",
  sendRecord: "pi:send-record",
  pickDirectory: "pi:pick-directory",
  revealFile: "pi:reveal-file",
  searchFiles: "pi:search-files",
  listDir: "pi:list-dir",
  makeDir: "pi:make-dir",
  listResources: "pi:list-resources",
  marketSearch: "pi:market-search",
  marketDetail: "pi:market-detail",
  githubBrowse: "pi:github-browse",
  githubText: "pi:github-text",
  githubImport: "pi:github-import",
  listImports: "pi:list-imports",
  exportResource: "pi:export-resource",
  modelsExport: "pi:models-export",
  modelsImport: "pi:models-import",
  modelsExportModel: "pi:models-export-model",
  modelsImportModel: "pi:models-import-model",
  settingsRead: "pi:settings-read",
  packageResources: "pi:package-resources",
  setPackageFilter: "pi:set-package-filter",
  settingsMerge: "pi:settings-merge",
  settingsSchema: "pi:settings-schema",
  settingsWrite: "pi:settings-write",
  importResourceFiles: "pi:import-resource-files",
  importStatus: "pi:import-status",
  recordCopy: "pi:record-copy",
  copyStatus: "pi:copy-status",
  hostInventory: "pi:host-inventory",
  listActionLog: "pi:list-action-log",
  updateState: "pi:update-state",
  checkForUpdates: "pi:check-for-updates",
  confirmUpdate: "pi:confirm-update",
  installUpdate: "pi:install-update",
  openRelease: "pi:open-release",
  updateStateChanged: "pi:update-state-changed",
  menuCommand: "pi:menu-command",
  logAction: "pi:log-action",
  importUpdate: "pi:import-update",
  importRemove: "pi:import-remove",
  importDiff: "pi:import-diff",
  getTrust: "pi:get-trust",
  setTrust: "pi:set-trust",
  readResource: "pi:read-resource",
  writeResource: "pi:write-resource",
  createResource: "pi:create-resource",
  createPackage: "pi:create-package",
  listMyPackages: "pi:list-my-packages",
  deleteMyPackage: "pi:delete-my-package",
  deleteResource: "pi:delete-resource",
  piStatus: "pi:pi-status",
  piLatest: "pi:pi-latest",
  piModels: "pi:pi-models",
  piVersions: "pi:pi-versions",
  dataBackup: "pi:data-backup",
  dataDelete: "pi:data-delete",
  piUpdate: "pi:pi-update",
  authProviders: "pi:auth-providers",
  authCheck: "pi:auth-check",
  authSetApiKey: "pi:auth-set-api-key",
  authRemove: "pi:auth-remove",
  terminalOpen: "pi:terminal-open",
  terminalWrite: "pi:terminal-write",
  terminalResize: "pi:terminal-resize",
  terminalClose: "pi:terminal-close",
  terminalData: "pi:terminal-data",
  terminalExit: "pi:terminal-exit",
  modelsRead: "pi:models-read",
  modelsSaveProvider: "pi:models-save-provider",
  modelsRemoveProvider: "pi:models-remove-provider",
  modelsProbe: "pi:models-probe",
  piUpdateOutput: "pi:pi-update-output",
  connectionChanged: "pi:connection-changed",
  sessionEvent: "pi:session-event",
  sessionExit: "pi:session-exit",
  uiResolved: "pi:ui-resolved",
  storedChanged: "pi:stored-changed",
  externalWrite: "pi:external-write",
  writerChanged: "pi:writer-changed",
  filesChanged: "pi:files-changed",
  playgroundOutput: "pi:playground-output",
} as const;
