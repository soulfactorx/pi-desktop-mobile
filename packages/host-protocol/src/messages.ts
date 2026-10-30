/**
 * 앱 ↔ Host Agent 데몬 사이에서 쓰는 메서드 이름과 파라미터·결과 타입.
 * 설계 문서 §3.2(프로토콜), §3.4(상주 세션) 참고.
 *
 * Pi가 보내는 RPC 이벤트 자체는 여기서 타입을 정하지 않는다(`unknown`).
 * Pi 업데이트로 새 이벤트가 생겨도 데몬은 그대로 중계·저장하고, 해석은 앱이 관대하게 한다.
 */

/** 프로토콜 버전. 호환되지 않게 바뀔 때만 올린다. */
export const HOST_PROTOCOL_VERSION = 1;

export const Methods = {
  hostInfo: "host.info",
  piLocate: "pi.locate",
  /** Pi Manager 상태 화면: 설치·Node·Git Bash·데이터 (읽기 전용) */
  piStatus: "pi.status",
  /** npm 레지스트리의 Pi 최신 버전 (1시간 캐시) */
  piLatest: "pi.latest",
  /** npm 레지스트리에 배포된 Pi 버전 목록 (1시간 캐시) */
  piVersions: "pi.versions",
  /** 이 호스트의 Pi가 쓸 수 있는 모델 (`pi --list-models`, 설정 폼의 선택지) */
  piModels: "pi.models",
  /** Pi 데이터 폴더(~/.pi/agent)를 tar.gz로 백업 */
  dataBackup: "data.backup",
  /** Pi 데이터 폴더 삭제 (Pi를 제거한 뒤에만, 되돌릴 수 없음) */
  dataDelete: "data.delete",
  /** Pi 업데이트 실행 (pi update). 출력은 pi.updateOutput 알림으로 흐른다 */
  piUpdate: "pi.update",
  /** 프로바이더 목록과 저장된 자격 증명의 종류 (키 값은 보내지 않는다) */
  authProviders: "auth.providers",
  /** pi auth check로 한 프로바이더의 인증 상태 확인 */
  authCheck: "auth.check",
  /** auth.json에 API 키 저장 */
  authSetApiKey: "auth.setApiKey",
  /** auth.json에서 자격 증명 삭제 */
  authRemove: "auth.remove",
  /** models.json의 사용자 정의 프로바이더 (apiKey 값은 가린다) */
  modelsRead: "models.read",
  /** 사용자 정의 프로바이더 저장 (폼 밖의 필드는 남긴다) */
  modelsSaveProvider: "models.saveProvider",
  modelsRemoveProvider: "models.removeProvider",
  /** 다른 호스트로 옮길 프로바이더 (비밀일 수 있는 값은 뺀다) */
  modelsExportProvider: "models.exportProvider",
  /** 다른 호스트에서 받은 프로바이더를 쓴다 */
  modelsImportProvider: "models.importProvider",
  /** 다른 호스트로 옮길 모델 하나 (비밀일 수 있는 헤더 값은 뺀다) */
  modelsExportModel: "models.exportModel",
  /** 다른 호스트에서 받은 모델을 같은 이름의 프로바이더에 넣는다 */
  modelsImportModel: "models.importModel",
  /** 설정에 적힌 패키지 하나가 내놓는 리소스와 켜짐 여부 */
  packagesResources: "packages.resources",
  /** 패키지 리소스를 켜고 끈다 (settings.json의 패키지 필터) */
  packagesSetFilter: "packages.setFilter",
  /** 스크립트를 이 호스트의 Pi SDK로 실행한다 (SDK Playground). 끝날 때까지 응답을 기다리고 출력은 playground.output으로 */
  playgroundRun: "playground.run",
  playgroundStop: "playground.stop",
  /** 파일·폴더 트리를 감시한다 (Extension Dev Mode). 바뀌면 files.changed로 알린다 */
  filesWatchTree: "files.watchTree",
  filesUnwatchTree: "files.unwatchTree",
  /** 사용자 settings.json의 최상위 값 */
  settingsRead: "settings.read",
  /** 설치된 Pi가 함께 배포한 settings.json의 JSON Schema (없으면 null) */
  settingsSchema: "settings.schema",
  /** settings.json의 고른 최상위 키만 바꾼다 (설정 폼, 다른 호스트에서 복사할 때) */
  settingsMerge: "settings.merge",
  /** settings.json 원본 글을 그대로 쓴다 (JSON 편집 모드, 읽은 뒤 바뀌었으면 거부) */
  settingsWrite: "settings.write",
  /** OpenAI 호환 엔드포인트의 /models를 이 호스트에서 불러 연결 시험 */
  modelsProbe: "models.probe",
  sessionOpen: "session.open",
  sessionList: "session.list",
  sessionAttach: "session.attach",
  sessionDetach: "session.detach",
  sessionSend: "session.send",
  sessionClose: "session.close",
  /** 다른 프로그램이 쓴 것으로 감지된 표시를 지운다 (사용자가 "무시하고 계속"을 고름) */
  sessionClearExternalWrite: "session.clearExternalWrite",
  /** 이 세션의 입력 권한(writer)을 가져온다. 가지고 있던 앱은 읽기 전용이 된다 (설계 §3.4) */
  sessionClaimWriter: "session.claimWriter",
  sessionHistory: "session.history",
  storedInspect: "stored.inspect",
  /** 저장된 세션 파일을 지운다. 바로 지우지 않고 데몬 홈의 휴지통(session-trash/)으로 옮긴다 */
  storedDelete: "stored.delete",
  /** 휴지통의 세션 목록 (예전 삭제가 남긴 session-backups/deleted/도 함께) */
  trashList: "trash.list",
  /** 휴지통의 세션을 원래 자리로 되살린다 */
  trashRestore: "trash.restore",
  /** 휴지통을 비운다 (고른 것만 또는 전부). 이때 정말 지운다 */
  trashEmpty: "trash.empty",
  /** 세션을 아카이브하거나 되돌린다. 파일은 그대로 두고 앱 목록에서만 숨긴다 (archive.json) */
  archiveSet: "archive.set",
  /** 에이전트 앱의 데이터 함수(agent-kit app-api)를 이 호스트에서 부른다. 데몬 홈이 Agent 홈이다 (DESIGN-APPS.md §6 D4) */
  agentCall: "agent.call",
  storedRead: "stored.read",
  storedWatch: "stored.watch",
  storedUnwatch: "stored.unwatch",
  /** 작업 폴더에서 파일을 찾는다 (입력창 @ 파일 피커) */
  fsSearch: "fs.search",
  /** 작업 폴더에서 Pi가 불러오는 리소스 목록 (AGENTS.md·프롬프트·스킬·확장, 읽기 전용) */
  resourcesList: "resources.list",
  /** 작업 폴더의 프로젝트 신뢰 상태 (Pi의 trust.json·defaultProjectTrust) */
  trustGet: "trust.get",
  /** 프로젝트 신뢰 결정을 Pi의 trust.json에 저장한다 */
  trustSet: "trust.set",
  /** 리소스 마크다운 파일 읽기·쓰기·새로 만들기 (데이터 폴더·.pi/·AGENTS.md만) */
  resourcesRead: "resources.read",
  resourcesWrite: "resources.write",
  resourcesCreate: "resources.create",
  /** ~/pi-packages/<이름>에 새 Pi 패키지를 만든다 (package.json·확장·고른 리소스 복사) */
  resourcesCreatePackage: "resources.createPackage",
  /** ~/pi-packages의 내 패키지 목록 */
  resourcesListPackages: "resources.listPackages",
  /** 내 패키지를 지운다 (백업 폴더로 옮긴다) */
  resourcesDeletePackage: "resources.deletePackage",
  /** 받은 스킬 폴더·프롬프트 파일을 사용자·프로젝트 범위에 쓴다 (개별 가져오기) */
  resourcesImport: "resources.import",
  /** 다른 호스트로 복사할 스킬 폴더·프롬프트 파일을 읽는다 */
  resourcesExport: "resources.export",
  /** 가져온 스킬 폴더·프롬프트 파일의 git blob SHA (로컬 수정 감지) */
  resourcesInspectImported: "resources.inspectImported",
  /** 가져온 스킬·프롬프트 안의 텍스트 파일 하나 (차이 보기) */
  resourcesReadImported: "resources.readImported",
  /** 가져온 스킬·프롬프트를 백업 폴더로 옮겨 없앤다 */
  resourcesRemoveImported: "resources.removeImported",
  /** 프롬프트·스킬·확장을 지운다 (백업 폴더로 옮긴다). 패키지에 든 것은 지우지 않는다 */
  resourcesDelete: "resources.delete",
  /** 한 폴더의 하위 폴더 목록 (폴더 탐색 창) */
  fsListDir: "fs.listDir",
  /** 세션을 시작할 새 폴더를 만든다 */
  fsMakeDir: "fs.makeDir",
  daemonStatus: "daemon.status",
  daemonShutdown: "daemon.shutdown",
} as const;

/**
 * 데몬이 Pi 이벤트 사이에 끼워 저널에 남기는 이벤트 (Pi에는 없는 것).
 *
 * Pi는 RPC `bash`(`!` 셸 명령)를 실행할 때 출력 조각(`bash_execution_update`)만 보내고 시작·끝 이벤트가 없다.
 * 그러면 명령을 보낸 화면 말고는(다른 탭, 다시 연결한 앱) 무슨 명령인지 알 수 없어서 데몬이 대신 남긴다.
 * `id`는 같은 명령의 `bash_execution_update.id`와 같다.
 */
export const DaemonEvents = {
  /** `{ type, id, command, excludeFromContext }` */
  bashStart: "pi_desktop_bash_start",
  /** `{ type, id, exitCode, cancelled, truncated, fullOutputPath?, error? }` */
  bashEnd: "pi_desktop_bash_end",
} as const;

/** 데몬 → 앱 알림 */
export const Notifications = {
  /**
   * 연결기가 데몬의 신원을 확인하지 못했다 (Windows에서 인증을 모르는 예전 데몬, 또는 그런 척하는 다른 프로그램).
   * 데몬이 아니라 연결기 자신이 맨 앞에 쓴다. 앱은 이 연결로 끄기 요청 말고는 보내지 않는다.
   */
  connectorUnverified: "connector.unverified",
  /** 세션에서 Pi 이벤트가 나왔다 (저널 순번 포함) */
  sessionEvent: "session.event",
  /** 세션의 Pi 프로세스가 끝났다 */
  sessionExit: "session.exit",
  /** 확장 다이얼로그가 처리되었다 */
  sessionUiResolved: "session.uiResolved",
  /** 이 데몬의 Pi가 쓰는 세션 파일에 다른 프로그램(TUI 등)이 쓴 것을 감지했다 */
  sessionExternalWrite: "session.externalWrite",
  /** 세션의 입력 권한(writer)이 바뀌었다. 붙어 있는 앱마다 자기 기준 값을 받는다 */
  sessionWriterChanged: "session.writerChanged",
  /** pi.update 진행 출력 (요청한 앱에만 보낸다) */
  piUpdateOutput: "pi.updateOutput",
  /** 감시 중인 저장 세션 파일이 바뀌었다 (다른 프로그램이 쓰는 중) */
  storedChanged: "stored.changed",
  /** files.watchTree로 감시하는 파일이 바뀌었다 */
  filesChanged: "files.changed",
  /** playground.run의 출력 (요청한 앱에만) */
  playgroundOutput: "playground.output",
} as const;

export interface HostInfo {
  protocolVersion: number;
  agentVersion: string;
  /**
   * 데몬이 실행 중인 번들 파일 SHA-256의 앞 12자리. 앱이 가진 번들과 다르면 예전 데몬이다 (설계 §3.4).
   * 번들 없이 실행했거나 이 필드를 모르는 예전 데몬이면 없다.
   */
  agentBuild?: string;
  /** Node의 process.platform 값 (win32, linux, darwin 등) */
  platform: string;
  arch: string;
  nodeVersion: string;
  pid: number;
  homeDir: string;
}

export interface PiLocation {
  /** Pi CLI 진입 파일(`dist/bundle/cli.js`)의 절대 경로 */
  cliPath: string;
  /** Pi 패키지 루트 */
  packageDir: string;
  version: string;
  /** 어떤 경로로 찾았는지 (설정값, 환경 변수, npm 전역 등) */
  source: "param" | "env" | "managed" | "npm-global";
  /**
   * Pi를 실행할 node. 관리형 설치기가 자체 Node(`pi-node`)를 깔았으면 그 경로이고,
   * 없으면 생략되어 데몬의 node를 그대로 쓴다.
   */
  nodePath?: string;
  /** Pi 프로세스에 추가로 줄 환경 변수 (예: 관리형 설치의 PI_MANAGED_INSTALL_ROOT, PATH) */
  env?: Record<string, string>;
}

/** Pi Manager 상태 (설계 §4.9 "상태 감지") */
export interface PiStatus {
  platform: string;
  /** 찾은 Pi. 못 찾았으면 없고 piError에 이유 */
  pi?: PiLocation;
  piError?: string;
  /** Pi를 실행할 node */
  node: {
    path: string;
    /** 예: "v22.19.0". 읽지 못했으면 없음 */
    version?: string;
    /** Pi package.json engines.node (예: ">=22.19.0") */
    required?: string;
    /** required를 만족하는지 */
    ok: boolean;
  };
  /** Windows만: Pi bash 툴이 쓸 Git Bash */
  gitBash?: { found: boolean; path?: string; source?: "settings" | "git" };
  data: {
    /** ~/.pi/agent (PI_CODING_AGENT_DIR) */
    agentDir: string;
    exists: boolean;
    sessionDir: string;
    sessions: { count: number; bytes: number; truncated: boolean };
    /** auth.json에 자격 증명이 있는 프로바이더 이름 (값은 보내지 않는다) */
    authProviders: string[];
    hasModelsJson: boolean;
    hasSettings: boolean;
  };
}

export interface PiLatestParams {
  /** 캐시를 무시하고 다시 묻는다 */
  force?: boolean;
}

/** npm 레지스트리의 Pi 최신 버전. 묻지 못했으면 error */
export interface PiLatest {
  version?: string;
  error?: string;
  checkedAt: number;
}

/** 모델 하나 (프로바이더와 모델 ID) */
export interface PiModelRef {
  provider: string;
  id: string;
}

/** `pi --list-models` 결과. 인증이 있는 프로바이더의 모델만 들어 있다. 읽지 못했으면 error */
export interface PiModelsResult {
  models: PiModelRef[];
  error?: string;
}

/** pi update 대상: Pi 자체, 설치한 패키지, 둘 다, 모델 카탈로그 */
export type PiUpdateTarget = "self" | "extensions" | "all" | "models";

export interface PiUpdateParams {
  target: PiUpdateTarget;
  /** 최신이어도 다시 설치한다 (models에는 쓰지 않는다) */
  force?: boolean;
  /** 앱이 정한 작업 ID. 진행 출력 알림을 이 작업과 맞추는 데 쓴다 */
  taskId: string;
}

export interface PiUpdateResult {
  exitCode: number | null;
  /** 출력 끝부분 (64KB) */
  output: string;
  timedOut: boolean;
  /** 실행 전·후 Pi 버전 (Pi를 찾지 못했으면 없음). 성공 여부는 종료 코드가 아니라 이것으로 본다 */
  versionBefore?: string;
  versionAfter?: string;
}

export interface PiUpdateOutputNotification {
  taskId: string;
  chunk: string;
}

/** 프로바이더 하나 (설계 §4.7). 자격 증명 값은 담지 않는다 */
export interface ProviderInfo {
  id: string;
  name: string;
  /** API 키 인증을 지원 */
  apiKey: boolean;
  /** OAuth 로그인을 지원 (Pi TUI의 /login 필요) */
  oauth: boolean;
  /** 내장 프로바이더가 아니라 models.json이나 auth.json에만 있음 */
  custom: boolean;
  /** auth.json에 저장된 자격 증명의 종류. 없으면 없음 */
  stored?: "api_key" | "oauth" | "other";
}

export interface AuthProviderParams {
  provider: string;
}

export interface AuthSetApiKeyParams {
  provider: string;
  /** API 키, 또는 "!명령" (시크릿 매니저에서 읽기) */
  key: string;
}

/** pi auth check 결과. ready: 쓸 수 있음, not_ready: 자격 증명 없음, invalid: 자격 증명이 잘못됨 */
export interface AuthCheckResult {
  provider: string;
  status: "ready" | "not_ready" | "invalid" | "unknown";
  reason?: string;
}

/** models.json 폼의 모델 하나 */
export interface CustomModelForm {
  id: string;
  name?: string;
  reasoning?: boolean;
  /** 이미지 입력을 받는다 (input에 "image") */
  image?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** models.json 폼의 프로바이더 하나 */
export interface CustomProviderForm {
  id: string;
  name?: string;
  baseUrl: string;
  /** 예: openai-completions, anthropic-messages */
  api: string;
  /** 없으면(undefined) 기존 값 유지, 빈 문자열이면 지움. 값, $환경변수, !명령 */
  apiKey?: string;
  models: CustomModelForm[];
}

/** 앱에 보여주는 사용자 정의 프로바이더. apiKey가 그대로 키 값이면 가린다 */
export interface CustomProviderView {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey: { kind: "none" | "literal" | "env" | "command"; value?: string };
  models: CustomModelForm[];
  /** 폼이 다루지 않아 그대로 남기는 필드 이름 (compat, headers 등) */
  extraFields: string[];
}

export interface ModelsFileView {
  path: string;
  exists: boolean;
  providers: CustomProviderView[];
  /** 파일이 깨져 읽지 못했으면 이유 (이때는 저장하지 않는다) */
  error?: string;
}

/** 다른 호스트로 옮길 models.json 프로바이더 (그대로 키 값인 apiKey·헤더는 뺀 것) */
export interface ModelsExportResult {
  provider: Record<string, unknown>;
  /** 비밀일 수 있어 뺀 필드 (apiKey, headers.<이름>) */
  dropped: string[];
}

export interface ModelsExportModelResult {
  model: Record<string, unknown>;
  /** 비밀일 수 있어 뺀 필드 (headers.<이름>) */
  dropped: string[];
}

export interface ModelsImportModelParams {
  providerId: string;
  model: Record<string, unknown>;
  /** 같은 ID가 있으면 바꾼다 (대상의 헤더 값은 남김) */
  replace?: boolean;
}

export interface ModelsImportParams {
  id: string;
  provider: Record<string, unknown>;
  /** 이미 있으면 바꾼다. 받은 쪽에 없는 apiKey·헤더는 대상의 것을 남긴다 */
  replace?: boolean;
}

export type PackageResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface PackageResourcesParams {
  /** 프로젝트 범위의 작업 폴더. 사용자 범위면 비워도 된다 */
  cwd: string;
  /** 설정에 적힌 그대로의 소스 */
  source: string;
  scope: "user" | "project";
  /** 사용자 패키지를 이 프로젝트(cwd)에서만 고르는 덧씌우기 (프로젝트 settings의 autoload: false 항목) */
  overlay?: boolean;
}

export interface PackageResourceItem {
  type: PackageResourceType;
  /** 파일 경로 (호스트 기준) */
  path: string;
  /** 필터에 적을 경로: 패키지 리소스 기준 폴더에서의 상대 경로 */
  pattern: string;
  enabled: boolean;
}

export interface PackageFilterChange {
  type: PackageResourceType;
  pattern: string;
  enabled: boolean;
}

export interface PackageSetFilterParams extends PackageResourcesParams {
  changes: PackageFilterChange[];
  /** 먼저 필터를 모두 지운다 (패키지가 내놓는 것을 모두 불러옴) */
  reset?: boolean;
  /** 종류별 필터 배열을 통째로 적는다. [] 는 그 종류를 하나도 불러오지 않음 */
  set?: Partial<Record<PackageResourceType, string[]>>;
}

/** 어느 settings.json인지. 없으면 사용자 범위 */
export interface SettingsTarget {
  scope?: "user" | "project";
  /** 프로젝트 범위의 작업 폴더 (그 아래 .pi/settings.json) */
  cwd?: string;
}

export interface SettingsReadResult {
  /** 읽은 파일 경로 (호스트 기준) */
  path: string;
  exists: boolean;
  /** 원본 글 (JSON 편집 모드). 파일이 없으면 빈 글 */
  raw: string;
  /** 수정 시각. 파일이 없으면 없음 */
  mtimeMs?: number;
  /** 최상위 키와 값 그대로 */
  values: Record<string, unknown>;
  /** 파일이 깨져 읽지 못했으면 이유 (이때는 쓰지 않는다) */
  error?: string;
}

export interface SettingsWriteParams extends SettingsTarget {
  content: string;
  /** 읽을 때의 수정 시각. null이면 새 파일이어야 한다 */
  baseMtime: number | null;
}

export interface SettingsMergeParams extends SettingsTarget {
  /** 바꿀 최상위 키와 값. 여기 없는 키는 그대로 둔다 */
  values: Record<string, unknown>;
  /** 지울 최상위 키 (Pi 기본값으로 되돌림) */
  remove?: string[];
}

export interface ModelsSaveParams {
  provider: CustomProviderForm;
  /** ID를 바꿀 때 원래 ID */
  previousId?: string;
}

export interface ModelsProbeParams {
  baseUrl: string;
  /** 시험에 쓸 키. 없고 providerId가 있으면 저장된 키를 쓴다 */
  apiKey?: string;
  providerId?: string;
}

export interface ModelsProbeResult {
  ok: boolean;
  url: string;
  status?: number;
  /** 엔드포인트가 알려 준 모델 ID */
  models: string[];
  error?: string;
}

/** 배포된 Pi 버전. 묻지 못했으면 error */
export interface PiVersions {
  versions: string[];
  error?: string;
}

export interface DataBackupResult {
  /** 만든 백업 파일 (호스트 기준 경로) */
  path: string;
  bytes: number;
}

export interface DataDeleteParams {
  /** 앱이 pi.status로 받은 데이터 폴더 경로. 데몬의 실제 경로와 같아야 지운다 */
  confirm: string;
}

export interface PiLocateParams {
  /** 지정하면 이 경로를 먼저 시도한다 */
  piCliPath?: string;
}

export interface SessionOpenParams {
  cwd: string;
  /** 이어서 열 Pi 세션 파일. 없으면 새 세션 */
  sessionFile?: string;
  /**
   * 이 세션 파일에서 분기한 새 세션으로 연다 (pi --fork). 다른 프로그램이 쓰고 있는 세션을
   * 같은 파일에 함께 쓰지 않고 이어 갈 때 쓴다. sessionFile과 함께 줄 수 없다.
   */
  forkFrom?: string;
  /** Pi CLI 경로를 직접 지정할 때 */
  piCliPath?: string;
  /** `pi --mode rpc` 뒤에 붙일 추가 인자 (예: `--provider`, `--model`) */
  piArgs?: string[];
  /** Pi 프로세스에만 추가로 줄 환경 변수 */
  env?: Record<string, string>;
  /**
   * 이번 실행에만 쓰는 프로젝트 신뢰 결정 (pi --approve / --no-approve).
   * 없으면 Pi가 저장된 결정과 defaultProjectTrust로 정한다. RPC 모드는 묻지 못하므로 "ask"면 건너뛴다
   */
  trust?: "yes" | "no";
  /**
   * 작업 폴더가 없으면 만들고 연다 (상위 폴더까지). 세션 파일의 폴더가 지워졌을 때
   * (예: WSL을 다시 시작해 비워진 /tmp) 같은 파일로 이어 쓰기 위해 쓴다.
   */
  createCwd?: boolean;
}

/**
 * 작업 폴더의 프로젝트 신뢰 (Pi security.md "Project trust").
 * .pi/의 확장·스킬·프롬프트·설정 등은 신뢰한 폴더에서만 불러온다. AGENTS.md는 신뢰와 상관없이 불러온다.
 */
export interface ProjectTrustInfo {
  cwd: string;
  /** 신뢰가 필요한 프로젝트 리소스가 있는지. 없으면 결정할 것이 없다 */
  required: boolean;
  /** trust.json에 저장된 결정 (이 폴더나 가장 가까운 상위 폴더). 없으면 null */
  saved: boolean | null;
  /** 저장된 결정이 없을 때 Pi의 기본값 */
  defaultProjectTrust: "ask" | "always" | "never";
  /**
   * 앱이 지금 세션을 열면 어떻게 되는지.
   * ask: 정해진 것이 없어 앱이 물어야 한다 (묻지 않고 열면 RPC 모드라 건너뜀)
   */
  effective: "trusted" | "untrusted" | "ask";
}

export interface TrustSetParams {
  cwd: string;
  /** true 신뢰, false 신뢰하지 않음, null 저장된 결정 지우기 */
  decision: boolean | null;
}

export type SessionState = "running" | "exited";

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  state: SessionState;
  /** 지금까지 저널에 쌓인 마지막 순번 (이벤트가 없으면 0) */
  lastSeq: number;
  /** Pi가 알려준 세션 파일 경로 (아직 모르면 없음) */
  sessionFile?: string;
  piVersion: string;
  startedAt: number;
  exitCode?: number | null;
  /** 답을 기다리는 확장 다이얼로그 수 (세션 목록에서 "입력 필요" 표시용) */
  pendingUi: number;
  /** Pi가 일하는 중 (agent_start ~ agent_settled). 활동 패널 표시용 */
  busy: boolean;
  /** 세션 이름, 없으면 이 프로세스가 받은 첫 질문. 아직 없으면 없음 */
  title?: string;
  /**
   * 다른 프로그램이 이 세션 파일에 쓴 것을 감지한 시각 (ms). 감지되지 않았으면 없음.
   * 같은 파일에 두 프로그램이 함께 쓰면 기록이 꼬이므로 앱은 입력을 잠그고 선택을 묻는다 (설계 §5.4)
   */
  externalWriteAt?: number;
}

export interface SessionOpenResult {
  session: SessionSummary;
}

export interface SessionAttachParams {
  sessionId: string;
  /** 앱이 마지막으로 받은 순번. 처음 붙을 때는 0 */
  lastSeq: number;
}

/**
 * 이 앱(데몬 연결) 기준의 입력 권한 (설계 §3.4 "여러 GUI가 같은 세션에 붙을 때").
 * - you: 이 앱이 입력할 수 있다
 * - other: 다른 앱이 가지고 있다. 이 앱은 읽기 전용이고, session.claimWriter로 가져올 수 있다
 * - none: 아무도 없다 (가지고 있던 앱이 끊김). 먼저 입력하는 앱이 가져간다
 */
export type WriterState = "you" | "other" | "none";

export interface SessionWriterChangedNotification {
  sessionId: string;
  writer: WriterState;
}

export interface SessionAttachResult {
  session: SessionSummary;
  /** 붙은 뒤 이 앱의 입력 권한. 아무도 없었으면 이 앱이 가져간다 */
  writer: WriterState;
  /**
   * 저널 앞부분이 잘려서 `lastSeq` 바로 다음부터 재생할 수 없었으면 true.
   * 이때 앱은 `get_messages` 같은 Pi 명령으로 현재 상태를 다시 받아야 한다.
   */
  truncated: boolean;
  /** 이 응답 직전에 재생(알림으로 전송)한 이벤트 범위. 재생할 것이 없으면 null */
  replayed: { fromSeq: number; toSeq: number } | null;
  /** 아직 아무도 답하지 않은 확장 다이얼로그(select·confirm·input·editor)의 요청 id */
  pendingUi: string[];
}

export interface SessionRef {
  sessionId: string;
}

export interface SessionSendParams {
  sessionId: string;
  /** Pi RPC 명령 객체 그대로 (예: `{ type: "prompt", message: "..." }`). `id`는 데몬이 붙인다 */
  command: Record<string, unknown>;
  /** Pi 응답을 기다리지 않는 명령 (예: `extension_ui_response`) */
  noResponse?: boolean;
}

/** Pi의 `type: "response"` 레코드 그대로 */
export type PiResponse = Record<string, unknown>;

export interface SessionEventNotification {
  sessionId: string;
  seq: number;
  /** 데몬이 이벤트를 받은 시각 (ms) */
  at: number;
  event: unknown;
}

/** 확장 다이얼로그가 처리되었다 (어느 앱이 답했거나 Pi가 제한 시간으로 자동 처리함) */
export interface SessionUiResolvedNotification {
  sessionId: string;
  /** extension_ui_request의 id */
  id: string;
}

export interface SessionExitNotification {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
  /** 마지막 stderr 일부. 시작 실패 원인을 보여줄 때 쓴다 */
  stderrTail: string;
}

/** session.history 요청. cwd를 주면 그 폴더의 세션만, 없으면 모든 폴더의 세션 */
export interface SessionHistoryParams {
  cwd?: string;
  /** Pi 세션 저장 위치를 직접 지정할 때 (기본: Pi 설정을 따름) */
  sessionDir?: string;
  piCliPath?: string;
  /** 최대 개수 (최근 수정 순). 기본 200 */
  limit?: number;
}

/** Pi가 디스크에 저장한 세션 하나 (Pi SDK SessionManager.list의 SessionInfo에서 필요한 부분) */
export interface StoredSession {
  /** 세션 파일 경로 */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  /** fork로 만들어졌으면 원래 세션 파일 */
  parentSessionPath?: string;
  /** ms */
  created: number;
  /** ms */
  modified: number;
  messageCount: number;
  /** 첫 사용자 메시지 (목록 표시용, 최대 200자) */
  firstMessage: string;
  /** 작업 폴더(cwd)가 이제 없다. Pi는 이 파일을 그대로 열지 못한다 (폴더를 다시 만들거나 다른 폴더로 분기해야 함) */
  cwdMissing?: boolean;
  /** 이 데몬 홈에서 아카이브한 세션 (앱 목록에서 숨기고 아카이브 화면에서 본다) */
  archived?: boolean;
}

export interface DaemonStatus {
  pid: number;
  agentVersion: string;
  agentBuild?: string;
  startedAt: number;
  clients: number;
  sessions: SessionSummary[];
  /** 세션·클라이언트가 모두 없을 때 스스로 종료하기까지의 대기 시간 (ms) */
  idleShutdownMs: number;
}

/** 답을 보내야 하는 확장 UI 메서드 (rpc-extension-ui.md). 나머지(notify, setStatus 등)는 알림만 한다. */
export const DIALOG_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];

/** stored.inspect / stored.read / stored.watch 요청 */
export interface FsSearchParams {
  /** 검색할 작업 폴더 (호스트 기준 경로) */
  cwd: string;
  /** 검색어. 비면 얕은 경로부터 */
  query: string;
  /** 최대 결과 수 (기본 50) */
  limit?: number;
}

export interface FsSearchResult {
  /** 작업 폴더 기준 상대 경로. 구분자는 "/", 폴더는 끝에 "/" */
  files: string[];
  /** 파일이 너무 많아 일부만 검색했다 */
  truncated: boolean;
}

export interface ResourcesListParams {
  /** 작업 폴더 (호스트 기준). 프로젝트 리소스(.pi/, 상위 폴더의 AGENTS.md)를 여기서 찾는다 */
  cwd: string;
}

/** 리소스 파일 요청의 공통 인자. cwd는 프로젝트 리소스 위치를 가리는 기준이다 */
export interface ResourcePathParams {
  cwd: string;
  path: string;
}

export interface ResourceFile {
  path: string;
  content: string;
  /** 읽은 때의 수정 시각. 저장할 때 그 사이 바뀌었는지 확인하는 데 쓴다 */
  mtimeMs: number;
}

export interface ResourceWriteParams extends ResourcePathParams {
  content: string;
  /** 읽었을 때의 수정 시각. 그 뒤에 바뀌었으면 거부한다. 없으면 새 파일이어야 한다 */
  baseMtime?: number;
}

export interface ResourceWriteResult {
  path: string;
  mtimeMs: number;
}

export type ResourceKind = "prompt" | "skill" | "agents" | "extension";

/** 새 확장의 처음 코드 종류 (extension-templates.ts) */
export type ExtensionTemplate = "command" | "tool" | "guard" | "blank";

/** 새 패키지 만들기 (리소스 창 패키지 탭) */
export interface PackageCreateParams {
  /** 패키지 이름 = 폴더 이름 = npm 이름 (소문자·숫자·하이픈) */
  name: string;
  description?: string;
  /** 넣을 확장의 처음 코드. 없으면 확장 없이 만든다 */
  extensionTemplate?: ExtensionTemplate;
  /** 함께 넣을 기존 리소스 (복사한다. 원본은 그대로) */
  include: Array<{ path: string; kind: "prompt" | "skill" | "extension" }>;
}

/** 앱이 만든 패키지 폴더(~/pi-packages)의 패키지 하나 */
export interface MyPackageInfo {
  /** 폴더 이름 */
  folder: string;
  dir: string;
  /** package.json의 name (없거나 깨졌으면 폴더 이름) */
  name: string;
  version?: string;
  description?: string;
  /** 폴더 안의 파일 (상대 경로, node_modules·.git 제외, 최대 200개) */
  files: string[];
}

export interface PackageCreateResult {
  /** 만든 패키지 폴더 (~/pi-packages/<이름>) */
  dir: string;
  /** 만든 파일들 (폴더 기준 상대 경로) */
  files: string[];
}

export interface ResourceImportParams {
  cwd: string;
  kind: "skill" | "prompt" | "extension";
  scope: "user" | "project";
  /** 가져와 쓸 이름 (소문자·숫자·하이픈) */
  name: string;
  /** 스킬·확장 폴더 기준 상대 경로와 내용. 프롬프트와 파일 하나 확장은 파일 하나 */
  files: Array<{ path: string; contentBase64: string }>;
  /** 이미 있으면 백업한 뒤 바꾼다 (가져온 항목 업데이트). 없으면 이미 있을 때 거부한다 */
  replace?: boolean;
}

export interface ResourceImportResult {
  /** 쓴 곳: 스킬 폴더 또는 프롬프트 파일 */
  target: string;
  files: number;
  /** replace로 바꾸었으면 이전 내용을 옮겨 둔 곳 */
  backup?: string;
}

export interface ResourceExportParams {
  kind: "skill" | "prompt" | "extension";
  /** 리소스 목록이 알려 준 파일 경로 (스킬은 SKILL.md, 프롬프트는 .md, 확장은 .ts·.js 또는 폴더의 index) */
  path: string;
}

export interface ResourceExportResult {
  /** 스킬 폴더 기준 경로(프롬프트는 파일 이름)와 내용 */
  files: Array<{ path: string; size: number; contentBase64: string }>;
  /** 확장 폴더에서 옮기지 않은 폴더 (node_modules·.git) */
  skipped?: string[];
  /** 확장 폴더의 package.json에 dependencies가 있다. 대상에서 npm install이 필요하다 */
  needsInstall?: boolean;
}

/** 가져온 항목 (스킬 폴더 또는 프롬프트 파일) */
export interface ImportedTargetParams {
  target: string;
  kind: "skill" | "prompt";
}

export interface ImportedInspectResult {
  exists: boolean;
  /** 스킬 폴더 기준 경로(프롬프트는 파일 이름) → git blob SHA */
  files: Record<string, string>;
}

export interface ResourceCreateParams {
  cwd: string;
  kind: ResourceKind;
  /** user: 데이터 폴더, project: 작업 폴더의 .pi/ (AGENTS.md는 작업 폴더) */
  scope: "user" | "project";
  /** 프롬프트·스킬·확장 이름 (소문자·숫자·하이픈). AGENTS.md는 쓰지 않는다 */
  name: string;
  /** 확장의 처음 코드 (기본: command) */
  template?: ExtensionTemplate;
}

/** 리소스가 어디서 왔는지 */
export interface ResourceSource {
  /** user: ~/.pi/agent, project: 작업 폴더의 .pi 등. Pi가 늘리면 그 값 그대로 */
  scope: string;
  /** auto(폴더에서 찾음), 패키지 소스(npm:… git:…), 설정에 적은 경로 등 */
  source: string;
  /** 설치한 패키지에 들어 있는 리소스인지 */
  fromPackage: boolean;
}

export interface ResourceItem extends ResourceSource {
  name: string;
  description?: string;
  /** 파일 경로 (호스트 기준) */
  path: string;
  /** 설정의 패키지 필터 등으로 꺼져 있으면 false */
  enabled: boolean;
  /** 프롬프트: 인자 안내 (예: <파일>) */
  argumentHint?: string;
  /** 스킬: 모델이 스스로 부르지 않고 /skill:이름으로만 쓴다 */
  disableModelInvocation?: boolean;
}

export interface ContextFileInfo {
  path: string;
  /** user: 데이터 폴더의 AGENTS.md, project: 작업 폴더와 그 상위 폴더 */
  scope: "user" | "project";
  bytes: number;
}

export interface ResourceDiagnosticInfo {
  kind: "prompt" | "skill";
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
}

export interface ConfiguredPackageInfo {
  source: string;
  scope: "user" | "project";
  /** 설정에서 이 패키지의 리소스 일부만 쓰도록 걸러 두었다 */
  filtered: boolean;
  installedPath?: string;
}

/** 작업 폴더에서 Pi가 불러오는 리소스. 확장은 코드를 실행하지 않고 경로만 찾는다 */
export interface ResourcesView {
  cwd: string;
  agentDir: string;
  /** 프로젝트 신뢰. trusted가 아니면 project 범위의 .pi/ 리소스는 세션에 불러오지 않는다 */
  trust: ProjectTrustInfo;
  /** 시스템 프롬프트에 들어가는 AGENTS.md(CLAUDE.md) 파일. 불러오는 순서대로 */
  contextFiles: ContextFileInfo[];
  /** 기본 시스템 프롬프트를 바꾸는 SYSTEM.md */
  systemPrompt?: string;
  /** 시스템 프롬프트 뒤에 붙는 APPEND_SYSTEM.md */
  appendSystemPrompt: string[];
  prompts: ResourceItem[];
  skills: ResourceItem[];
  extensions: ResourceItem[];
  themes: ResourceItem[];
  packages: ConfiguredPackageInfo[];
  diagnostics: ResourceDiagnosticInfo[];
}

export interface FsMakeDirParams {
  /** 상위 폴더 (호스트 기준). 비었거나 "~"면 홈, 상대 경로는 홈 기준 */
  parent?: string;
  name: string;
}

export interface FsListDirParams {
  /** 볼 폴더 (호스트 기준). 비었거나 "~"면 홈, 상대 경로는 홈 기준 */
  path?: string;
}

export interface FsListDirResult {
  /** 실제로 연 폴더의 절대 경로 */
  path: string;
  /** 상위 폴더. 루트면 없다 */
  parent?: string;
  /** 호스트의 홈 폴더 */
  home: string;
  /** 하위 폴더 이름 (가나다순, 숨김 폴더 포함) */
  dirs: string[];
  /** 너무 많아 일부만 담았다 */
  truncated: boolean;
}

export interface StoredPathParams {
  /** 세션 파일 경로 */
  path: string;
  piCliPath?: string;
}

/** 저장된 세션 파일의 상태. 다른 프로그램이 쓰고 있는지 판단하는 데 쓴다 */
export interface StoredInspectResult {
  path: string;
  exists: boolean;
  size: number;
  /** 마지막 수정 시각 (ms) */
  modified: number;
  /** 이 데몬의 실행 중인 세션이 이 파일을 쓰고 있으면 그 세션 id */
  ownedBy?: string;
}

/** 세션 파일을 지운 결과. 파일이 아직 없었으면(첫 메시지 전) backup이 없다 */
export interface StoredDeleteResult {
  path: string;
  /** 옮긴 곳 (휴지통 안). 휴지통에서 되살릴 수 있다 */
  backup?: string;
  /** 휴지통 항목 id (trash.restore에 넘긴다) */
  trashId?: string;
}

/** 휴지통의 세션 하나 */
export interface TrashItem {
  /** 휴지통 안 파일 이름. trash.restore·trash.empty에 넘긴다 */
  id: string;
  /** 되살릴 자리 */
  originalPath: string;
  /** ms */
  deletedAt: number;
  sessionId: string;
  cwd: string;
  name?: string;
  /** 첫 사용자 메시지 (최대 200자) */
  firstMessage: string;
  size: number;
  /** 예전 삭제(session-backups/deleted/)가 남긴 것. 원래 자리는 Pi 규칙으로 계산했다 */
  legacy?: boolean;
}

export interface TrashRestoreParams {
  id: string;
}

export interface TrashRestoreResult {
  /** 되살린 세션 파일 경로 */
  path: string;
}

export interface TrashEmptyParams {
  /** 지울 항목. 없으면 전부 */
  ids?: string[];
}

export interface TrashEmptyResult {
  removed: number;
}

export interface AgentCallParams {
  /** agent-kit app-api의 함수 이름 (예: kbList) */
  name: string;
  /** 그 함수의 인자 (JSON) */
  args?: unknown[];
}

export interface ArchiveSetParams {
  /** 세션 파일 경로 */
  path: string;
  archived: boolean;
}

/** 저장된 세션 파일을 읽어 만든 현재 갈래의 대화 (파일은 읽기만 한다) */
export interface StoredReadResult {
  path: string;
  /** Pi AgentMessage 목록 (현재 갈래, 컴팩션 반영) */
  messages: unknown[];
  leafId: string | null;
  model: { provider: string; modelId: string } | null;
  size: number;
  modified: number;
}

/** stored.changed 알림 */
export interface PlaygroundRunParams {
  /** 앱이 정한 실행 ID (출력·중지를 맞추는 데 쓴다) */
  runId: string;
  /** ES 모듈 JavaScript. 앞에 `const pi = await import(<Pi SDK>)`가 붙는다 */
  code: string;
  /** 작업 폴더 (없으면 홈) */
  cwd?: string;
  timeoutMs?: number;
}

export interface PlaygroundRunResult {
  exitCode: number | null;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
  /** 출력이 한도를 넘어 잘렸다 */
  truncated: boolean;
}

export interface PlaygroundOutputNotification {
  runId: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface FilesWatchTreeParams {
  /** 앱이 정한 감시 ID. 같은 ID로 다시 부르면 뿌리를 바꾼다 */
  watchId: string;
  /** 감시할 파일·폴더 (호스트 기준). 폴더는 아래를 모두 보되 node_modules·.git은 건너뛴다 */
  roots: string[];
}

export interface FilesChangedNotification {
  watchId: string;
  /** 생기거나 바뀌거나 사라진 파일 */
  paths: string[];
}

export interface StoredChangedNotification {
  path: string;
  size: number;
  modified: number;
}

/** session.externalWrite 알림 */
export interface SessionExternalWriteNotification {
  sessionId: string;
  /** 감지한 시각 (ms) */
  at: number;
  /** 바뀐 세션 파일 */
  path: string;
}
