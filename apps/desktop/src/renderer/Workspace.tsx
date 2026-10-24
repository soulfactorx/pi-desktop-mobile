import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfiguredPackageInfo, StoredSession } from "@pi-desktop/host-protocol/messages";
import type { PendingQueue } from "./chat-state";
import { ChatView } from "./ChatView";
import { ChoiceDialog } from "./ChoiceDialog";
import { PiManager, usePiStatus } from "./PiManager";
import { ResourcesPanel } from "./ResourcesPanel";
import { MarketplacePanel } from "./MarketplacePanel";
import { CopyResourceDialog, type CopyItem } from "./CopyResourceDialog";
import { ContextCopyDialog } from "./ContextCopyDialog";
import { PackageCopyDialog } from "./PackageCopyDialog";
import { hasReloadCommand, RELOAD_COMMAND } from "./resources-view";
import { TerminalDock, type DockTerminal } from "./TerminalDock";
import type { TerminalSpec } from "./TerminalView";
import { updateState } from "./pi-manager-view";
import { CommandPalette } from "./CommandPalette";
import type { PaletteCommand } from "./palette";
import { Composer } from "./Composer";
import { modelAcceptsImages, rpcImages, type ImageAttachment } from "./attachments";
import type { ParsedInput, PiCommand } from "./composer-input";
import { terminalActionDetail } from "./activity-view";
import { EventInspector } from "./EventInspector";
import { useExtensionDevMode } from "./use-dev-mode";
import { parseAppSlash, splitModelArg, withAppCommands, type AppSlashCommand } from "./app-commands";
import { PlaygroundPanel } from "./PlaygroundPanel";
import { baseName, formatRelative } from "./format";
import { piSessionIdOf, tuiCommand } from "./tui-command";
import { useSession } from "./use-session";
import { ExtensionDialog, StatusLine, Toasts, Widgets } from "./ExtensionUi";
import { FolderBrowser } from "./FolderBrowser";
import { NewFolderDialog } from "./NewFolderDialog";
import logoUrl from "../../build/icon.svg?url";
import { SshHostsDialog } from "./SshHostsDialog";
import { restoreQueueToDraft } from "./run-status";
import { QueuePanel, RetryBanner } from "./RunStatus";
import { SessionBar } from "./SessionBar";
import { Sidebar } from "./Sidebar";
import { TreePanel } from "./TreePanel";
import { useSessionInfo } from "./use-session-info";
import { staleProviders } from "./session-refresh";

/** 탭 표시와 백그라운드 알림에 쓰는 워크스페이스 상태 */
export interface WorkspaceStatus {
  title: string;
  hostId: string;
  /** 호스트 이름 (예: 로컬, WSL: Ubuntu) */
  hostLabel: string;
  running: boolean;
  /** 확장 다이얼로그, 끼어들기 경고, 열기 선택처럼 사용자의 답을 기다림 */
  needsInput: boolean;
  disconnected: boolean;
  /** 보고 있는 세션 (활동 패널에서 이 탭으로 오기 위해) */
  sessionId?: string;
}

interface WorkspaceProps {
  tabId: string;
  /** 지금 보이는 탭인지. 숨긴 탭도 연결과 상태는 유지한다 */
  active: boolean;
  onStatus: (tabId: string, status: WorkspaceStatus) => void;
  /** 명령 팔레트에 넣을 앱 수준 명령 (탭 열기·닫기·이동) */
  appCommands: PaletteCommand[];
}

/**
 * 워크스페이스 하나 = 탭 하나 (설계 §3.3). 호스트와 세션을 탭마다 따로 가진다.
 */
/** 호스트 선택 목록에서 SSH 호스트 관리 창을 여는 항목 */
const SSH_MANAGE = "__ssh-manage__";
/** 로그인 뒤 세션 새로고침이 필요한지 다시 보는 간격 (auth.json만 읽어 가볍다) */
const AUTH_CHECK_MS = 30_000;

/** 메뉴바 명령을 지금 탭에 전하는 창 이벤트 (detail: 명령 id) */
export const MENU_EVENT = "pi-desktop-menu";

/** Pi 설치 명령 뒤 상태를 다시 읽는 간격과 최대 시간 (설치기가 메뉴로 물어보며 기다릴 수 있다) */
const PI_WATCH_INTERVAL_MS = 3_000;
const PI_WATCH_LIMIT_MS = 30 * 60_000;

/** 설치·제거·업데이트로 바뀌었는지 비교할 Pi 위치·버전 */
function piFingerprint(pi: { cliPath: string; version: string } | undefined): string {
  return pi ? `${pi.cliPath}@${pi.version}` : "";
}

export function Workspace({ tabId, active, onStatus, appCommands }: WorkspaceProps) {
  const {
    hosts,
    host,
    hostId,
    selectHost,
    reloadHosts,
    connection,
    sessions,
    session,
    lost,
    chat,
    ui,
    openSession,
    reopenLost,
    switchTo,
    send,
    respondDialog,
    openStored,
    branchSession,
    follow,
    pendingOpen,
    cancelPendingOpen,
    stopFollow,
    handOffToTui,
    closeSession,
    closeAllSessions,
    restartSession,
    resumeFollowed,
    continueFollowedAsFork,
    ignoreExternalWrite,
    writer,
    claimWriter,
    trustAsk,
    answerTrust,
    dismissToast,
  } = useSession(tabId);
  const isLocal = host?.kind === "local";
  // OS 폴더 대화상자·탐색기는 데스크톱 앱에서만 쓴다. 웹(pi-web)은 서버의 폴더를 앱의 탐색 창으로 고른다.
  const desktopShell = window.piDesktop.shell === "electron";
  const osPicker = isLocal && desktopShell;
  const canReveal = desktopShell && (host?.kind === "local" || host?.kind === "wsl");
  const [cwd, setCwd] = useState("");
  const [draft, setDraftState] = useState("");
  const [commands, setCommands] = useState<PiCommand[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** 오류가 아닌 알림 (예: HTML로 내보낸 위치) */
  const [info, setInfo] = useState<string | undefined>();
  /** 값이 바뀌면 사이드바가 기록을 다시 읽는다 */
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [treeOpen, setTreeOpen] = useState(false);
  const [piManagerOpen, setPiManagerOpen] = useState(false);
  const [piManagerTab, setPiManagerTab] = useState<"status" | "providers" | "settings">("status");
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  /** 새 폴더 대화상자가 상위 폴더를 고르려고 연 탐색 창의 응답 */
  const browseForParent = useRef<((path: string | undefined) => void) | undefined>(undefined);
  const [agentReplaceAsk, setAgentReplaceAsk] = useState(false);
  const [sshHostsOpen, setSshHostsOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  /** 다른 호스트로 복사할 리소스 */
  const [copyItem, setCopyItem] = useState<CopyItem | undefined>();
  /** 다른 호스트로 복사할 사용자 범위 AGENTS.md 등 */
  const [copyContextPath, setCopyContextPath] = useState<string | undefined>();
  /** 다른 호스트에 설치할 패키지 */
  const [copyPackage, setCopyPackage] = useState<ConfiguredPackageInfo | undefined>();
  /** 아래 도크의 내장 터미널들 (설계 §4.12) */
  const [dockTerminals, setDockTerminals] = useState<DockTerminal[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | undefined>();
  /** title을 주면 그 제목을 유지하고, 없으면 열린 뒤 실행 정보(예: "셸 (WSL: Ubuntu)")로 채운다 */
  const openTerminal = (spec: TerminalSpec, title?: string, onSuccess?: () => void) => {
    // 설치·제거·업데이트처럼 대신 실행하는 명령은 작업 기록에 남긴다 (결과는 터미널 출력에서 본다).
    const detail = terminalActionDetail(spec);
    if (detail) void window.piDesktop.logAction({ hostId: spec.hostId, summary: `터미널에서 실행: ${title ?? "명령"}`, detail }).catch(() => {});
    const key = crypto.randomUUID();
    setDockTerminals((prev) => [...prev, { key, spec, title: title ?? "터미널", fixedTitle: title !== undefined, ...(onSuccess ? { onSuccess } : {}) }]);
    setActiveTerminal(key);
    return key;
  };
  /**
   * 그 호스트의 pi를 이 인자로 내장 터미널에서 실행한다 (패키지 설치·제거·업데이트).
   * 프로젝트 범위 명령만 그 폴더에서, 사용자 범위는 홈에서 연다. 프로젝트 폴더에서 열면 Pi가 그 폴더의 신뢰를 묻기 때문이다.
   */
  const runPiOn = (target: string, args: string[], title: string, projectCwd?: string, onSuccess?: () => void) =>
    openTerminal({ hostId: target, kind: "pi", args, ...(projectCwd ? { cwd: projectCwd } : {}) }, title, onSuccess);
  const runPi = (args: string[], title: string, projectCwd?: string, onSuccess?: () => void) =>
    runPiOn(hostId, args, title, projectCwd, onSuccess);
  const closeTerminal = (key: string) => {
    setDockTerminals((prev) => {
      const next = prev.filter((t) => t.key !== key);
      setActiveTerminal((current) => (current === key ? next.at(-1)?.key : current));
      return next;
    });
  };
  /** 명령 팔레트가 열려 있으면 그때 읽은 최근 기록 */
  const [palette, setPalette] = useState<{ history: StoredSession[]; query?: string } | undefined>();
  const root = useRef<HTMLDivElement>(null);
  const [handoffAsk, setHandoffAsk] = useState(false);
  const [handoffCommand, setHandoffCommand] = useState<string | undefined>();

  const connected = connection.status === "connected";
  const sessionInfo = useSessionInfo(hostId, session, connected && !lost);

  // 로그인한 프로바이더의 모델을 이 세션이 모르는지 (session-refresh.ts). Pi는 세션을 시작할 때 모델을 읽으므로
  // 다른 곳(Pi 관리, 터미널 /login, 다른 PC)에서 로그인하면 세션 새로고침을 권한다.
  const [staleAuth, setStaleAuth] = useState<string[]>([]);
  const [staleAuthDismissed, setStaleAuthDismissed] = useState("");
  const sessionModels = sessionInfo.info.modelsLoaded ? sessionInfo.info.models : undefined;
  const checkAuth = useCallback(async () => {
    if (!sessionModels || !connected) {
      setStaleAuth([]);
      return;
    }
    const providers = await window.piDesktop.authProviders(hostId).catch(() => undefined);
    setStaleAuth(providers ? staleProviders(providers, sessionModels) : []);
  }, [hostId, connected, sessionModels]);
  useEffect(() => {
    void checkAuth();
    if (!active) return;
    // 창으로 돌아올 때(브라우저 로그인 뒤 등)와, 내장 터미널의 /login처럼 창을 떠나지 않는 경우를 위해 가끔 다시 본다.
    const onFocus = () => void checkAuth();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => void checkAuth(), AUTH_CHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [active, checkAuth]);
  useEffect(() => {
    if (!piManagerOpen) void checkAuth();
  }, [piManagerOpen, checkAuth]);
  const staleAuthKey = staleAuth.join(", ");
  // 상단 바의 Pi 버전·업데이트 표시 (연결되면 한 번 읽는다. 최신 버전은 데몬이 캐시)
  const piState = usePiStatus(hostId, connected);
  const piUpdate = updateState(piState.status?.pi?.version, piState.latest);
  /**
   * Pi 설치·제거·업데이트 명령을 셸 터미널에 보낸 뒤, Pi 상태가 바뀔 때까지 몇 초마다 다시 읽는다.
   * 명령은 셸 안에서 돌아 끝나도 터미널이 닫히지 않으므로 종료 코드로는 알 수 없다. 터미널을 닫으면 한 번 더 읽고 그만둔다.
   */
  const [piWatch, setPiWatch] = useState<{ terminalKey: string; hostId: string; before: string; until: number } | undefined>();
  const reloadPi = piState.reload;
  useEffect(() => {
    if (!piWatch) return;
    const done = () => {
      setPiWatch(undefined);
      // 기록은 사이드바가 piMissing이 바뀌면 다시 읽는다.
      void reloadPi(true);
    };
    if (piWatch.hostId !== hostId) {
      setPiWatch(undefined);
      return;
    }
    if (!dockTerminals.some((t) => t.key === piWatch.terminalKey)) {
      done();
      return;
    }
    const timer = setInterval(() => {
      if (Date.now() > piWatch.until) {
        setPiWatch(undefined);
        return;
      }
      void window.piDesktop
        .piStatus(piWatch.hostId)
        .then((status) => {
          if (piFingerprint(status.pi) !== piWatch.before) done();
        })
        .catch(() => {});
    }, PI_WATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [piWatch, hostId, dockTerminals, reloadPi]);
  // Pi가 제거됐는데(상태가 "Pi 없음") 실행 중인 세션이 남아 있으면 모두 닫는다.
  // 지워진 설치본의 Pi 프로세스가 계속 돌며 쓰지 못하게 하기 위해서다. 대화는 세션 파일에 남는다.
  const piMissing = Boolean(piState.status && !piState.status.pi);
  const hasRunning = sessions.some((s) => s.state === "running");
  useEffect(() => {
    if (!piMissing || !hasRunning || !connected) return;
    void closeAllSessions().then(
      (closed) => closed > 0 && setInfo(`Pi가 제거되어 실행 중이던 세션 ${closed}개를 닫았습니다. 대화는 기록에 남아 Pi를 다시 설치하면 이어서 열 수 있습니다.`),
      () => {},
    );
  }, [piMissing, hasRunning, connected, closeAllSessions]);
  // 이 앱의 Pi가 쓰는 세션 파일에 다른 프로그램이 썼다 (TUI 등). 같은 파일에 함께 쓰면 기록이 꼬이므로 입력을 잠근다.
  const externalWrite = session?.externalWriteAt !== undefined && !lost;
  // 다른 앱(다른 PC 등)이 이 세션의 입력 권한을 가지고 있다. 실시간으로 보기만 한다 (설계 §3.4).
  const readOnly = Boolean(session) && writer === "other" && !lost;
  // 리소스 창은 보고 있는 세션의 폴더, 없으면 입력창의 폴더 기준으로 연다.
  const resourcesCwd = session?.cwd ?? cwd.trim();

  // 입력 중인 초안을 세션 파일별로 저장해 두었다가 그 세션을 다시 열면 되살린다.
  const draftKey = session ? `pi-desktop.draft.${hostId}.${session.sessionFile ?? session.sessionId}` : undefined;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  /** 세션을 바꾸면서 넣을 글 (분기 직후 원래 질문). 새 세션의 저장된 초안보다 우선한다 */
  const pendingDraft = useRef<string | undefined>(undefined);
  const setDraft = useCallback((text: string) => {
    setDraftState(text);
    saveDraft(draftKeyRef.current, text);
  }, []);
  useEffect(() => {
    const text = pendingDraft.current ?? loadDraft(draftKey);
    pendingDraft.current = undefined;
    setDraftState(text);
    saveDraft(draftKey, text);
  }, [draftKey]);

  // `/` 자동완성용 명령 목록은 세션마다 다르므로(프로젝트 프롬프트·스킬) 세션이 바뀌면 다시 읽는다.
  const sessionId = session?.sessionId;
  useEffect(() => setCommands(undefined), [sessionId]);
  const loadCommands = useCallback(() => {
    if (!sessionId) return;
    setCommands([]);
    void window.piDesktop
      .sendCommand(hostId, sessionId, { type: "get_commands" })
      .then((response) => {
        const list = (response.data as { commands?: PiCommand[] } | undefined)?.commands;
        setCommands(Array.isArray(list) ? list : []);
      })
      // 실패하면 빈 목록으로 두어 계속 다시 요청하지 않는다. 세션이 바뀌면 다시 읽는다.
      .catch(() => setCommands([]));
  }, [hostId, sessionId]);

  /**
   * 고친 리소스를 보고 있는 세션에 바로 반영한다 (bridge 확장의 /desktop:reload, 설계 §5.3).
   * bridge가 없는 세션(앱 업데이트 전에 연 세션)에 보내면 LLM에 질문으로 가므로 명령 목록을 먼저 확인한다.
   */
  const reloadSessionResources = useCallback(async () => {
    if (!sessionId) throw new Error("보고 있는 세션이 없습니다");
    const listed = await window.piDesktop.sendCommand(hostId, sessionId, { type: "get_commands" });
    const list = (listed.data as { commands?: PiCommand[] } | undefined)?.commands ?? [];
    if (!hasReloadCommand(list)) {
      throw new Error("이 세션은 앱을 업데이트하기 전에 열려 바로 반영할 수 없습니다. 세션을 닫고 다시 열면 반영됩니다.");
    }
    if (chat.running) throw new Error("작업 중에는 반영할 수 없습니다. 끝난 뒤 다시 누르세요.");
    const response = await window.piDesktop.sendCommand(hostId, sessionId, { type: "prompt", message: `/${RELOAD_COMMAND}` });
    if (response.success !== true) throw new Error(`반영하지 못했습니다: ${String(response.error ?? "알 수 없는 오류")}`);
    // 새로 만든 프롬프트·스킬이 / 자동완성에 보이도록 명령 목록을 다시 읽게 한다.
    setCommands(undefined);
  }, [hostId, sessionId, chat.running]);

  // Extension Dev Mode: 확장 파일을 저장하면 이 세션에 바로 반영한다 (입력 권한이 있을 때만).
  const devMode = useExtensionDevMode({
    tabId,
    hostId,
    sessionId: session && !lost && !readOnly ? session.sessionId : undefined,
    cwd: session?.cwd,
    connected,
    running: chat.running,
    reload: reloadSessionResources,
  });

  // 입력창 @ 파일 피커: 데몬이 세션 작업 폴더에서 찾는다 (WSL이면 WSL 안의 파일).
  const sessionCwd = session?.cwd;
  const searchFiles = useCallback(
    async (query: string) => {
      if (!sessionCwd) return [];
      return (await window.piDesktop.searchFiles(hostId, sessionCwd, query)).files;
    },
    [hostId, sessionCwd],
  );

  // 확장이 setTitle로 바꾼 제목을 창 제목에 반영한다 (보이는 탭만).
  useEffect(() => {
    if (active) document.title = ui.title ? `${ui.title} — Pi Desktop` : "Pi Desktop";
  }, [ui.title, active]);

  // 탭 표시와 백그라운드 알림을 위해 상태를 알린다.
  const statusTitle = ui.title ?? sessionInfo.info.sessionName ?? session?.title ?? follow?.title ?? (session ? baseName(session.cwd) : follow ? baseName(follow.cwd) : "새 탭");
  const needsInput = ui.dialogs.length > 0 || externalWrite || Boolean(pendingOpen);
  const disconnected = connection.status === "disconnected";
  const hostLabel = host?.label ?? hostId;
  useEffect(() => {
    const sessionId = session?.sessionId;
    onStatus(tabId, {
      title: statusTitle,
      hostId,
      hostLabel,
      running: chat.running,
      needsInput,
      disconnected,
      ...(sessionId ? { sessionId } : {}),
    });
  }, [onStatus, tabId, statusTitle, hostId, hostLabel, chat.running, needsInput, disconnected, session?.sessionId]);

  // 확장이 set_editor_text로 넣어 달라고 한 글을 입력창에 채운다.
  // 요청(seq)마다 한 번만 적용해, 사용자가 이어서 고친 내용을 다시 덮어쓰지 않는다.
  const editorText = ui.editorText;
  useEffect(() => {
    if (editorText) setDraft(editorText.text);
  }, [editorText?.seq]);

  /**
   * 다이얼로그 응답처럼 다른 작업을 막지 않아야 하는 동작용. 실패만 배너로 보여준다.
   * (확장 명령을 보낸 prompt는 다이얼로그에 답할 때까지 끝나지 않아 busy 상태이므로 guard를 쓰면 안 된다)
   */
  async function guardQuiet(task: () => Promise<void>) {
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function guard(task: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 팔로우가 끝나면 터미널 안내도 지운다.
  useEffect(() => {
    if (!follow) setHandoffCommand(undefined);
  }, [follow]);

  /** 지금 세션을 터미널 pi로 넘긴다: GUI 쪽 Pi를 닫고 명령을 복사한 뒤 읽기 전용으로 따라 보여준다. */
  async function handOff() {
    setHandoffAsk(false);
    await guard(async () => {
      const target = await handOffToTui();
      if (!target) return;
      const posix = host?.kind === "wsl" || connection.status !== "connected" || connection.host.platform !== "win32";
      const sessionId = target.exists ? undefined : piSessionIdOf(target.sessionFile);
      const command = tuiCommand(posix ? "posix" : "windows", target.cwd, sessionId ? { sessionId } : { sessionFile: target.sessionFile });
      if (target.exists) setHandoffCommand(command);
      else {
        setInfo(
          `메시지를 주고받기 전이라 세션 파일이 아직 없어, 같은 세션 ID로 TUI를 여는 명령을 복사했습니다. 이 창은 따라 보지 않으며, TUI에서 대화한 뒤 기록에서 열 수 있습니다.\n${command}`,
        );
      }
      try {
        await navigator.clipboard.writeText(command);
      } catch {
        // 복사에 실패해도 배너에 명령이 보이므로 직접 복사할 수 있다.
      }
    });
  }

  /** 트리에서 고른 질문 직전에서 분기한다. Pi가 돌려준 질문 원문을 입력창에 채워 고쳐 보낼 수 있게 한다. */
  function forkAt(entryId: string) {
    void guard(async () => {
      const data = await branchSession({ type: "fork", entryId });
      if (typeof data?.text === "string") {
        pendingDraft.current = data.text;
        setDraft(data.text);
      }
    });
  }

  /**
   * 세션을 HTML로 내보낸다. 사용자 저장소에 파일이 생기지 않도록 세션 파일 옆에 만든다.
   * 로컬·WSL이면 탐색기에서 보여주고, 어느 경우든 경로를 알림으로 남긴다.
   */
  async function exportHtml() {
    if (!session) return;
    const path = await sessionInfo.exportHtml(session.sessionFile);
    if (!path) throw new Error("HTML 내보내기 결과에 파일 경로가 없습니다");
    const revealed = await window.piDesktop.revealFile(hostId, session.cwd, path);
    setInfo(revealed ? `HTML로 내보냈습니다 (탐색기에서 열림): ${path}` : `HTML로 내보냈습니다: ${path}`);
  }

  /** 대기 중인 Steer·Follow-up을 취소하고 그 글을 입력창으로 되돌린다 (TUI의 Esc). */
  async function clearQueue() {
    if (!session) return;
    const response = await window.piDesktop.sendCommand(hostId, session.sessionId, { type: "clear_queue" });
    if (response.success !== true) throw new Error(String(response.error ?? "clear_queue 실패"));
    setDraft(restoreQueueToDraft(response.data as Partial<PendingQueue> | undefined, draft));
  }

  /**
   * 중단. Pi는 abort만 하면 큐에 남은 메시지를 이어서 처리하므로, 큐를 먼저 입력창으로 꺼낸 뒤 멈춘다
   * (Pi rpc-commands.md clear_queue 안내와 같은 순서).
   */
  /** 명령 팔레트를 연다. 최근 기록과 Pi 명령 목록을 함께 읽는다 */
  async function openPalette(query?: string) {
    setPalette({ history: [], ...(query ? { query } : {}) });
    if (session && !commands) loadCommands();
    if (!connected) return;
    const history = await window.piDesktop.listHistory(hostId, undefined).catch(() => []);
    setPalette((prev) => (prev ? { ...prev, history: history.slice(0, 15) } : prev));
  }

  // 팔레트가 닫혀 화면에서 빠진 다음에 포커스를 준다 (같은 순간에 주면 사라지는 입력칸에 밀린다).
  const focusComposer = () =>
    setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 30);

  /** 지금 상태에서 쓸 수 있는 명령. 쓸 수 없는 것은 disabled로 빠진다 */
  function paletteCommands(history: StoredSession[]): PaletteCommand[] {
    const ready = Boolean(session) && connected && !lost;
    const idle = ready && !chat.running;
    const list: PaletteCommand[] = [...appCommands];
    if (session) {
      list.push({
        id: "session-new-here",
        group: "세션",
        title: "같은 폴더에서 새 세션",
        hint: baseName(session.cwd),
        disabled: !connected,
        run: () => void guard(() => openSession(session.cwd)),
      });
    }
    for (const s of sessions) {
      if (s.sessionId === session?.sessionId || s.state !== "running") continue;
      list.push({
        id: `session-${s.sessionId}`,
        group: "실행 중",
        title: s.title ?? baseName(s.cwd),
        hint: baseName(s.cwd),
        run: () => void guard(() => switchTo(s)),
      });
    }
    // 실행 중인 세션은 위 "실행 중"에 있으므로 기록에서는 뺀다.
    const liveFiles = new Set(sessions.filter((s) => s.state === "running").map((s) => s.sessionFile));
    for (const h of history) {
      if (h.path === session?.sessionFile || liveFiles.has(h.path)) continue;
      list.push({
        id: `history-${h.path}`,
        group: "기록",
        title: h.name ?? (h.firstMessage || "(빈 세션)"),
        hint: `${formatRelative(h.modified)} · ${baseName(h.cwd)}`,
        run: () => void guard(() => openStored(h)),
      });
    }
    list.push(
      {
        id: "terminal-pi",
        group: "터미널",
        title: "터미널: pi 열기 (이 폴더)",
        keywords: "terminal tui pi 터미널",
        disabled: !connected,
        run: () => openTerminal({ hostId, kind: "pi", ...(session ? { cwd: session.cwd } : {}) }),
      },
      {
        id: "terminal-shell",
        group: "터미널",
        title: "터미널: 셸 열기",
        keywords: "terminal shell powershell bash 터미널",
        disabled: !connected,
        run: () => openTerminal({ hostId, kind: "shell", ...(session ? { cwd: session.cwd } : {}) }),
      },
    );
    list.push({
      id: "sdk-playground",
      group: "개발자 도구",
      title: "SDK Playground (이 호스트의 Pi SDK로 스크립트 실행)",
      keywords: "sdk playground script javascript run 스크립트 실행 개발자",
      run: () => setPlaygroundOpen(true),
    });
    list.push({
      id: "extension-dev-mode",
      group: "개발자 도구",
      title: devMode.on ? "Extension Dev Mode 끄기" : "Extension Dev Mode 켜기 (확장을 저장하면 바로 반영)",
      keywords: "extension dev mode reload watch hot 확장 개발 자동 반영 리로드",
      disabled: !session || Boolean(lost) || readOnly || !connected,
      run: devMode.toggle,
    });
    list.push({
      id: "event-inspector",
      group: "개발자 도구",
      title: "Event Inspector (이 세션의 RPC 이벤트 원본)",
      keywords: "event inspector rpc raw json debug 이벤트 디버그 개발자",
      disabled: !session,
      run: () => setInspectorOpen(true),
    });
    list.push({
      id: "marketplace",
      group: "Pi",
      title: "Marketplace (Pi 패키지 찾기·설치)",
      keywords: "marketplace packages npm install extension skill 마켓 패키지 설치 확장",
      disabled: !connected,
      run: () => setMarketOpen(true),
    });
    list.push({
      id: "resources",
      group: "Pi",
      title: "리소스 보기 (AGENTS.md·프롬프트·스킬·확장)",
      keywords: "resources agents prompts skills extensions packages 리소스 프롬프트 스킬 확장 패키지",
      disabled: !connected || !resourcesCwd,
      run: () => setResourcesOpen(true),
    });
    list.push({
      id: "pi-manager",
      group: "Pi",
      title: "Pi 관리 (설치 상태·버전)",
      keywords: "pi manager install update version 업데이트 설치",
      run: () => setPiManagerOpen(true),
    });
    list.push(
      { id: "abort", group: "실행", title: "중단", disabled: !ready || !chat.running, run: () => void guard(abortRun) },
      {
        id: "clear-queue",
        group: "실행",
        title: "대기 중인 메시지를 입력창으로",
        disabled: !ready || chat.queue.steering.length + chat.queue.followUp.length === 0,
        run: () => void guardQuiet(clearQueue),
      },
      {
        id: "compact",
        group: "세션",
        title: "대화 요약 (Compact)",
        keywords: "compaction",
        disabled: !idle,
        run: () => void guard(sessionInfo.compact),
      },
      {
        id: "auto-compact",
        group: "세션",
        title: sessionInfo.info.autoCompaction ? "자동 컴팩션 끄기" : "자동 컴팩션 켜기",
        keywords: "auto compaction 자동 요약",
        disabled: !ready || sessionInfo.info.autoCompaction === undefined,
        run: () => void guard(() => sessionInfo.setAutoCompaction(!sessionInfo.info.autoCompaction)),
      },
      {
        id: "tree",
        group: "세션",
        title: treeOpen ? "트리 닫기" : "트리 열기",
        keywords: "tree fork 분기",
        disabled: !session,
        run: () => setTreeOpen((v) => !v),
      },
      { id: "export", group: "세션", title: "HTML로 내보내기", keywords: "export html", disabled: !ready, run: () => void guard(exportHtml) },
      {
        id: "session-restart",
        group: "세션",
        title: "세션 새로고침 (Pi를 다시 띄워 모델·인증을 새로 읽기)",
        keywords: "restart refresh reload login model auth",
        disabled: !ready || chat.running || readOnly,
        run: () => void guard(restartSession),
      },
      {
        id: "tui",
        group: "세션",
        title: "터미널 pi(TUI)에서 열기",
        keywords: "tui handoff terminal",
        disabled: !ready || !session?.sessionFile,
        run: () => setHandoffAsk(true),
      },
    );
    for (const level of sessionInfo.info.thinkingLevels) {
      list.push({
        id: `thinking-${level}`,
        group: "Thinking",
        title: `Thinking: ${level}`,
        disabled: !idle || level === sessionInfo.info.thinkingLevel,
        run: () => void guard(() => sessionInfo.setThinkingLevel(level)),
      });
    }
    const current = sessionInfo.info.model;
    for (const model of sessionInfo.info.models) {
      list.push({
        id: `model-${model.provider}/${model.id}`,
        group: "모델",
        title: model.name ?? model.id,
        hint: model.provider,
        keywords: model.id,
        disabled: !idle || (current?.provider === model.provider && current.id === model.id),
        run: () => void guard(() => sessionInfo.setModel(model.provider, model.id)),
      });
    }
    for (const c of commands ?? []) {
      list.push({
        id: `pi-${c.name}`,
        group: "Pi 명령",
        title: `/${c.name}`,
        ...(c.description ? { hint: c.description } : {}),
        disabled: !ready,
        run: () => {
          setDraft(`/${c.name} `);
          focusComposer();
        },
      });
    }
    return list;
  }

  // Ctrl+K: 명령 팔레트 (보이는 탭만)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        void openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function abortRun() {
    if (chat.queue.steering.length + chat.queue.followUp.length > 0) await clearQueue();
    await send({ type: "abort" });
  }

  /** 입력창 앱 명령을 처리한다 (TUI 기본 명령에 해당하는 앱 동작) */
  async function runAppSlash(command: AppSlashCommand, args: string) {
    if (command.unsupported) {
      setInfo(`/${command.name}: ${command.unsupported}`);
      return;
    }
    switch (command.name) {
      case "model": {
        const target = args ? splitModelArg(args) : undefined;
        if (target) await sessionInfo.setModel(target.provider, target.modelId);
        else void openPalette(args || "model");
        return;
      }
      case "thinking":
        if (args) await sessionInfo.setThinkingLevel(args as Parameters<typeof sessionInfo.setThinkingLevel>[0]);
        else void openPalette("Thinking");
        return;
      case "compact":
        if (args) {
          await send({ type: "compact", customInstructions: args });
          await sessionInfo.refresh();
        } else await sessionInfo.compact();
        return;
      case "new":
        if (session) await openSession(session.cwd);
        return;
      case "resume":
        void openPalette();
        return;
      case "name":
        if (args) {
          await send({ type: "set_session_name", name: args });
          await sessionInfo.refresh();
        } else setInfo(`세션 이름: ${sessionInfo.info.sessionName ?? "(없음)"}`);
        return;
      case "session": {
        const response = await window.piDesktop.sendCommand(hostId, session!.sessionId, { type: "get_session_stats" });
        setInfo(`세션 정보\n${JSON.stringify(response.data ?? {}, null, 2)}`);
        return;
      }
      case "tree":
        setTreeOpen(true);
        return;
      case "fork":
        setTreeOpen(true);
        setInfo("트리에서 분기할 메시지를 고른 뒤 \"여기서 분기\"를 누르세요.");
        return;
      case "clone":
        await branchSession({ type: "clone" });
        return;
      case "copy": {
        const response = await window.piDesktop.sendCommand(hostId, session!.sessionId, { type: "get_last_assistant_text" });
        const text = (response.data as { text?: string } | undefined)?.text;
        if (!text) {
          setInfo("복사할 답변이 없습니다.");
          return;
        }
        await navigator.clipboard.writeText(text);
        setInfo("마지막 답변을 복사했습니다.");
        return;
      }
      case "export":
        await exportHtml();
        return;
      case "reload":
        await reloadSessionResources();
        setInfo("확장·스킬·프롬프트·컨텍스트를 다시 불러왔습니다.");
        return;
      case "settings":
        setPiManagerTab("settings");
        setPiManagerOpen(true);
        return;
      case "login":
        if (args) openTerminal({ hostId, kind: "pi", initialInput: `/login ${args}\r` }, `pi 로그인 (${args})`);
        else {
          setPiManagerTab("providers");
          setPiManagerOpen(true);
        }
        return;
      case "logout":
        setPiManagerTab("providers");
        setPiManagerOpen(true);
        return;
      case "trust":
        setResourcesOpen(true);
        return;
      case "hotkeys":
        void openPalette();
        return;
    }
  }

  /** 실행 중이면 Pi 규칙대로 steer/followUp 중 하나를 지정해야 한다. */
  function submit(
    input: Exclude<ParsedInput, { kind: "empty" }>,
    behavior: "steer" | "followUp" | undefined,
    attachments: ImageAttachment[],
  ) {
    if (!session) return;
    setDraft("");
    if (input.kind === "bash") {
      // 셸 명령은 끝나야 응답이 오므로 다른 조작을 막지 않는다. 진행은 셸 카드로 보인다.
      void guardQuiet(() => send({ type: "bash", command: input.command, excludeFromContext: input.excludeFromContext }));
      return;
    }
    const { message } = input;
    // TUI 기본 명령(/model, /compact …)은 RPC로 오지 않으므로 앱이 처리한다 (app-commands.ts).
    const appSlash = attachments.length === 0 ? parseAppSlash(message, commands) : undefined;
    if (appSlash) {
      void guard(() => runAppSlash(appSlash.command, appSlash.args));
      return;
    }
    const images = rpcImages(attachments);
    void guard(() =>
      send({
        type: "prompt",
        message,
        ...(behavior ? { streamingBehavior: behavior } : {}),
        ...(images ? { images } : {}),
      }),
    );
  }

  // 메뉴바 명령: 지금 탭만 처리한다. 대부분은 같은 id의 명령 팔레트 명령을 실행한다.
  const menuRef = useRef<(id: string) => void>(() => {});
  menuRef.current = (id: string) => {
    switch (id) {
      case "palette":
        void openPalette();
        return;
      case "folder-pick":
        if (osPicker) void guard(async () => {
          const picked = await window.piDesktop.pickDirectory();
          if (picked) setCwd(picked);
        });
        else setFolderBrowserOpen(true);
        return;
      case "new-folder":
        setNewFolderOpen(true);
        return;
      case "pi-providers":
      case "pi-settings":
        setPiManagerTab(id === "pi-providers" ? "providers" : "settings");
        setPiManagerOpen(true);
        return;
      case "model":
        void openPalette("model");
        return;
      case "thinking":
        void openPalette("Thinking");
        return;
    }
    const command = paletteCommands([]).find((c) => c.id === id);
    if (!command) {
      setInfo("지금은 할 수 없는 메뉴입니다 (세션이나 연결이 필요할 수 있습니다).");
      return;
    }
    if (command.disabled) {
      setInfo(`지금은 할 수 없습니다: ${command.title}`);
      return;
    }
    command.run();
  };
  useEffect(() => {
    if (!active) return;
    const onMenu = (e: Event) => menuRef.current((e as CustomEvent<string>).detail);
    window.addEventListener(MENU_EVENT, onMenu);
    return () => window.removeEventListener(MENU_EVENT, onMenu);
  }, [active]);

  return (
    <div className="app" hidden={!active} ref={root}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={logoUrl} alt="" />
          Pi Desktop
        </div>
        <select
          className="host-select"
          aria-label="호스트"
          value={hostId}
          onFocus={reloadHosts}
          onChange={(e) => {
            if (e.target.value === SSH_MANAGE) {
              setSshHostsOpen(true);
              return;
            }
            setCwd("");
            selectHost(e.target.value);
          }}
        >
          {!hosts.some((h) => h.id === hostId) && <option value={hostId}>{hostId}</option>}
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
          <option value={SSH_MANAGE}>SSH 호스트 관리…</option>
        </select>
        <ConnectionBadge connection={connection} />
        {connection.status === "connected" && connection.agentUpdate && (
          <button
            type="button"
            className="badge warn"
            onClick={() => setAgentReplaceAsk(true)}
            title="떠 있는 Host Agent가 이 앱보다 예전 것입니다. 실행 중인 세션이 모두 끝나면 자동으로 바꿉니다."
          >
            Agent 업데이트 대기
          </button>
        )}
        {connected && (
          <button
            type="button"
            className={`pi-version${piUpdate === "available" ? " update" : ""}${piState.status && !piState.status.pi ? " missing" : ""}`}
            onClick={() => setPiManagerOpen(true)}
            title={piUpdate === "available" ? `Pi ${piState.latest?.version}로 업데이트할 수 있습니다` : "Pi 설치 상태"}
          >
            {piState.status?.pi ? `Pi ${piState.status.pi.version}` : piState.status ? "Pi 없음" : "Pi"}
            {piUpdate === "available" && <span className="pi-update-dot">↑ 새 버전</span>}
          </button>
        )}
        <div className="spacer" />
        {session && (
          // 아래 입력줄(새 세션을 시작할 폴더)과 헷갈리지 않게 "지금 세션"의 폴더 이름만 보이고, 전체 경로는 툴팁에 둔다.
          <div
            className="session-meta"
            title={`지금 보고 있는 세션의 폴더: ${session.cwd}\nPi ${session.piVersion}${session.sessionFile ? `\n${session.sessionFile}` : ""}`}
          >
            <span className="session-meta-label">지금 세션</span> {baseName(session.cwd)}
          </div>
        )}
        {devMode.on && (
          <button
            type="button"
            className={`dev-mode-chip${devMode.status?.error ? " error" : ""}`}
            onClick={devMode.toggle}
            title={`Extension Dev Mode: 확장 파일을 저장하면 이 세션에 바로 반영합니다. 눌러서 끕니다.${devMode.status ? `\n${devMode.status.text}` : ""}`}
          >
            Dev Mode{devMode.waiting ? " · 반영 대기" : devMode.status ? ` · ${devMode.status.error ? "실패" : devMode.status.text}` : " · 감시 중"}
          </button>
        )}
        {connected && resourcesCwd && (
          <button type="button" onClick={() => setResourcesOpen(true)} title="이 폴더에서 Pi가 불러오는 AGENTS.md·프롬프트·스킬·확장">
            리소스
          </button>
        )}
        {session && !lost && (
          <button
            type="button"
            disabled={!connected || busy}
            onClick={() => void guard(exportHtml)}
            title="이 세션을 HTML 파일로 내보내고 탐색기에서 보여줍니다"
          >
            HTML 내보내기
          </button>
        )}
        {session?.sessionFile && !lost && (
          <button type="button" onClick={() => setHandoffAsk(true)} title="이 세션을 터미널의 pi로 이어서 엽니다">
            TUI에서 열기
          </button>
        )}
      </header>

      <section className="toolbar">
        <label className="toolbar-label" htmlFor={`cwd-${tabId}`} title="새 세션을 시작할 폴더입니다. 지금 보고 있는 세션의 폴더는 상단 바에 있습니다.">
          새 세션 폴더
        </label>
        <input
          id={`cwd-${tabId}`}
          className="cwd"
          placeholder={
            isLocal
              ? "새 세션을 시작할 폴더 경로"
              : host?.kind === "ssh"
                ? "서버의 작업 폴더 경로 (예: /home/me/project)"
                : "WSL 안의 작업 폴더 경로 (예: /home/me/project)"
          }
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={!connected || busy}
        />
        {/* Windows 폴더 선택 대화상자는 Windows 파일 시스템만 보여준다. WSL 같은 다른 호스트는 데몬으로 훑는 탐색 창을 쓴다. */}
        <button
          type="button"
          disabled={!connected || busy}
          onClick={() =>
            osPicker
              ? void guard(async () => {
                  const picked = await window.piDesktop.pickDirectory();
                  if (picked) setCwd(picked);
                })
              : setFolderBrowserOpen(true)
          }
        >
          폴더 선택
        </button>
        <button type="button" disabled={!connected || busy} onClick={() => setNewFolderOpen(true)} title="세션을 시작할 새 폴더를 이 호스트에 만듭니다">
          새 폴더
        </button>
        <button
          type="button"
          className="primary"
          disabled={!connected || busy || !cwd.trim()}
          onClick={() => void guard(() => openSession(cwd.trim()))}
        >
          새 세션
        </button>
      </section>

      <div className="workspace">
        <Sidebar
          hostId={hostId}
          connected={connected}
          sessions={sessions}
          current={session}
          disabled={!connected || busy}
          onSelect={(target) => void guard(() => switchTo(target))}
          onOpenStored={(stored) => void guard(() => openStored(stored))}
          onClose={(target) => void guard(() => closeSession(target))}
          {...(piState.status ? { piMissing: !piState.status.pi } : piState.error ? { piMissing: false } : {})}
          onInstallPi={() => {
            setPiManagerTab("status");
            setPiManagerOpen(true);
          }}
          {...(sessionInfo.info.sessionName ? { currentName: sessionInfo.info.sessionName } : {})}
          {...(session && !lost && connected
            ? {
                onRename: (name: string) =>
                  guard(async () => {
                    await sessionInfo.rename(name);
                    setHistoryRefresh((n) => n + 1);
                  }),
              }
            : {})}
          refreshKey={historyRefresh}
        />
        <div className="main">

      {connection.status === "disconnected" && (
        <div className="banner error">
          {host?.label ?? hostId}에 연결하지 못했습니다. 자동으로 다시 시도합니다.
          {"\n"}
          {connection.reason}
        </div>
      )}
      {lost && connected && (
        <div className="banner warn">
          <span>
            {lost.reason === "missing"
              ? "Host Agent가 재시작되어 이 세션의 Pi 프로세스가 없습니다."
              : "이 세션의 Pi 프로세스가 종료되었습니다."}
            {lost.sessionFile
              ? " 같은 세션 파일로 다시 열면 대화를 이어 갈 수 있습니다."
              : " 세션 파일이 없어 새 세션으로 열립니다."}
          </span>
          <button type="button" className="primary" disabled={busy} onClick={() => void guard(reopenLost)}>
            다시 열기
          </button>
        </div>
      )}
      {externalWrite && (
        <div className="banner warn">
          <span>
            다른 프로그램(터미널의 pi 등)이 이 세션 파일에 쓰고 있습니다. 같은 파일에 함께 쓰면 기록이 꼬일 수 있어 입력을
            잠갔습니다.
          </span>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void guard(async () => void (await handOffToTui()))}
            title="이 앱의 Pi를 닫고, 다른 프로그램이 쓰는 내용을 읽기 전용으로 따라갑니다"
          >
            닫고 따라가기
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void guard(async () => void (await branchSession({ type: "clone" })))}
            title="지금까지의 이 앱 쪽 대화를 새 파일로 복제해 따로 이어 갑니다"
          >
            복제해서 계속
          </button>
          <button type="button" disabled={busy} onClick={() => void guard(ignoreExternalWrite)} title="기록이 섞일 수 있습니다">
            무시하고 계속
          </button>
        </div>
      )}
      {readOnly && (
        <div className="banner warn">
          <span>다른 앱(다른 PC 등)이 이 세션을 조작하고 있습니다. 실시간으로 보기만 하며, 입력하려면 제어를 가져오세요.</span>
          <button
            type="button"
            className="primary"
            disabled={busy || !connected}
            onClick={() => void guard(claimWriter)}
            title="입력 권한을 이 앱으로 옮깁니다. 다른 앱은 읽기 전용이 됩니다"
          >
            제어 가져오기
          </button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {info && (
        <div className="banner info">
          <span>{info}</span>
          <button type="button" className="small" onClick={() => setInfo(undefined)} aria-label="알림 닫기">
            닫기
          </button>
        </div>
      )}
      {staleAuth.length > 0 && staleAuthKey !== staleAuthDismissed && session && !lost && (
        <div className="banner warn">
          <span>
            로그인한 {staleAuthKey}의 모델이 이 세션에는 아직 없습니다. Pi는 세션을 시작할 때 모델을 읽으므로 세션을 새로고침해야 보입니다
            (같은 세션 파일로 다시 띄워 대화는 그대로 이어집니다).
          </span>
          <button
            type="button"
            className="primary"
            disabled={busy || chat.running || readOnly}
            title={chat.running ? "작업이 끝난 뒤 누르세요" : undefined}
            onClick={() => void guard(restartSession)}
          >
            세션 새로고침
          </button>
          <button type="button" onClick={() => setStaleAuthDismissed(staleAuthKey)}>
            나중에
          </button>
        </div>
      )}
      {chat.retry && <RetryBanner retry={chat.retry} onCancel={() => void guardQuiet(() => send({ type: "abort_retry" }))} />}
      {follow && (
        <div className="banner follow">
          <span>
            읽기 전용으로 따라가는 중입니다{follow.title ? `: ${follow.title}` : ""}. 다른 프로그램이 이 세션 파일에 쓰는 내용이
            그대로 보입니다.
            {handoffCommand && (
              <>
                {"\n"}터미널에서 실행하세요 (클립보드에 복사됨): <code>{handoffCommand}</code>
              </>
            )}
            {"\n"}TUI를 끝냈으면 "GUI에서 이어 쓰기"로 이 세션을 다시 엽니다. TUI를 계속 쓰면서 GUI에서도 쓰려면 분기하세요.
          </span>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void guard(resumeFollowed)}
            title="같은 세션 파일을 GUI에서 다시 엽니다. TUI가 아직 열려 있으면 기록이 섞일 수 있으니 먼저 TUI를 끝내세요."
          >
            GUI에서 이어 쓰기
          </button>
          <button type="button" disabled={busy} onClick={() => void guard(continueFollowedAsFork)}>
            분기해서 이어 쓰기
          </button>
          <button type="button" onClick={() => stopFollow()}>
            그만 보기
          </button>
        </div>
      )}

      {session && (
        <SessionBar
          info={sessionInfo.info}
          running={chat.running}
          disabled={!connected || Boolean(lost) || busy || readOnly}
          onModel={(provider, id) => void guard(() => sessionInfo.setModel(provider, id))}
          onThinking={(level) => void guard(() => sessionInfo.setThinkingLevel(level))}
          onCompact={() => void guard(sessionInfo.compact)}
          onAutoCompaction={(enabled) => void guard(() => sessionInfo.setAutoCompaction(enabled))}
          treeOpen={treeOpen}
          onToggleTree={() => setTreeOpen((open) => !open)}
        />
      )}

      <ChatView
        items={chat.items}
        running={chat.running}
        onResend={(text) => setDraft(text)}
        actions={{
          onAbortBash: () => void guardQuiet(() => send({ type: "abort_bash" })),
          // 탐색기에서 볼 수 있는 호스트(로컬, WSL)만
          ...(session && canReveal
            ? {
                onReveal: (path: string) =>
                  void guardQuiet(async () => {
                    await window.piDesktop.revealFile(hostId, session.cwd, path);
                  }),
              }
            : {}),
        }}
      />

      <Widgets ui={ui} placement="aboveEditor" />
      <QueuePanel queue={chat.queue} onClear={() => void guardQuiet(clearQueue)} />
      <Composer
        value={draft}
        onChange={setDraft}
        disabled={!session || !connected || Boolean(lost) || Boolean(follow) || Boolean(externalWrite) || readOnly}
        placeholder={
          session
            ? "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈, ↑ 이전 입력, / 명령, @ 파일, 이미지 붙여넣기, !셸 명령, !!컨텍스트 제외)"
            : "먼저 세션을 여세요"
        }
        running={chat.running}
        commands={commands ? withAppCommands(commands) : undefined}
        onNeedCommands={loadCommands}
        onSearchFiles={searchFiles}
        acceptsImages={modelAcceptsImages(sessionInfo.info.model)}
        onSubmit={submit}
        onAbort={() => void guard(abortRun)}
      />
      <Widgets ui={ui} placement="belowEditor" />
      <StatusLine ui={ui} />
      <TerminalDock
        terminals={dockTerminals}
        active={activeTerminal}
        onActivate={setActiveTerminal}
        onClose={closeTerminal}
        onUpdate={(key, fields) => setDockTerminals((prev) => prev.map((t) => (t.key === key ? { ...t, ...fields } : t)))}
      />
        </div>
        {session && treeOpen && (
          <TreePanel
            hostId={hostId}
            session={session}
            disabled={!connected || Boolean(lost) || busy || chat.running}
            onFork={forkAt}
            onClone={() => void guard(async () => void (await branchSession({ type: "clone" })))}
            onClose={() => setTreeOpen(false)}
          />
        )}
      </div>
      {/* 다이얼로그와 토스트는 보이는 탭에서만 띄운다. 숨긴 탭의 요청은 남아 있다가 탭을 열면 뜬다. */}
      {active && ui.dialogs[0] && (
        <ExtensionDialog
          dialog={ui.dialogs[0]}
          onAnswer={(answer) => void guardQuiet(() => respondDialog(ui.dialogs[0]!, answer))}
        />
      )}
      {pendingOpen && (
        <ChoiceDialog
          title="다른 곳에서 쓰고 있을 수 있는 세션입니다"
          onCancel={cancelPendingOpen}
          choices={[
            { label: "읽기 전용으로 따라가기", kind: "primary", onSelect: () => void guard(() => openStored(pendingOpen, "follow")) },
            { label: "분기해서 새 세션으로 이어 쓰기", onSelect: () => void guard(() => openStored(pendingOpen, "fork")) },
            { label: "그래도 이 파일로 열기", kind: "danger", onSelect: () => void guard(() => openStored(pendingOpen, "open")) },
          ]}
        >
          이 세션 파일은 {formatRelative(pendingOpen.modified)} 수정되었고, 이 앱이 쓰고 있는 파일이 아닙니다. 터미널의 Pi(TUI)
          등에서 열려 있다면 같은 파일에 함께 쓸 때 기록이 꼬일 수 있습니다.
        </ChoiceDialog>
      )}
      {trustAsk && (
        <ChoiceDialog
          title="이 폴더를 신뢰할까요?"
          onCancel={() => answerTrust(undefined)}
          choices={[
            { label: "이번만 신뢰하지 않고 열기", onSelect: () => answerTrust("once-no") },
            { label: "신뢰하고 열기 (기억)", kind: "primary", onSelect: () => answerTrust("remember-yes") },
            { label: "이번만 신뢰하고 열기", onSelect: () => answerTrust("once-yes") },
            { label: "신뢰하지 않음으로 기억하고 열기", onSelect: () => answerTrust("remember-no") },
          ]}
        >
          {trustAsk.cwd}
          {"\n\n"}이 폴더에는 프로젝트 리소스(.pi/의 확장·스킬·프롬프트·설정 등)가 있습니다. 신뢰하면 Pi가 이것들을 불러오고
          프로젝트 확장의 코드를 실행합니다. 신뢰하지 않아도 AGENTS.md는 불러옵니다. 기억한 결정은 터미널 pi의 /trust와
          같은 곳(~/.pi/agent/trust.json)에 저장되며, 리소스 창에서 바꿀 수 있습니다.
        </ChoiceDialog>
      )}
      {agentReplaceAsk && connection.status === "connected" && connection.agentUpdate && (
        <ChoiceDialog
          title="Host Agent 업데이트 대기"
          onCancel={() => setAgentReplaceAsk(false)}
          choices={[
            { label: "세션이 끝나면 바꾸기", kind: "primary", onSelect: () => setAgentReplaceAsk(false) },
            {
              label: "지금 바꾸기",
              kind: "danger",
              onSelect: () => {
                setAgentReplaceAsk(false);
                void guard(() => window.piDesktop.replaceAgent(hostId));
              },
            },
          ]}
        >
          {hostLabel}에 떠 있는 Host Agent가 이 앱보다 예전 것입니다. 실행 중인 Pi 세션이 {connection.agentUpdate.liveSessions}개
          있어 바꾸지 않았습니다. 세션이 모두 끝나면 앱이 알아서 바꿉니다. 지금 바꾸면 실행 중인 세션이 끝나며, 대화는 세션
          파일에 남아 "다시 열기"로 이어 갈 수 있습니다. 진행 중인 응답은 이어지지 않습니다.
        </ChoiceDialog>
      )}
      {handoffAsk && session && (
        <ChoiceDialog
          title="터미널 Pi(TUI)로 넘기기"
          onCancel={() => setHandoffAsk(false)}
          choices={[{ label: "GUI 세션을 닫고 명령 복사", kind: "primary", onSelect: () => void handOff() }]}
        >
          같은 파일에 GUI와 TUI가 함께 쓰지 않도록 GUI 쪽 Pi를 먼저 닫습니다. 그 뒤 터미널에서 실행할 명령을 복사하고, 이
          창에서는 읽기 전용으로 계속 따라 보여줍니다.
        </ChoiceDialog>
      )}
      {active && <Toasts toasts={ui.toasts} onDismiss={dismissToast} />}
      {active && resourcesOpen && resourcesCwd && (
        <ResourcesPanel
          hostId={hostId}
          hostLabel={hostLabel}
          hosts={hosts}
          cwd={resourcesCwd}
          {...(canReveal
            ? { onReveal: (path: string) => void guardQuiet(async () => void (await window.piDesktop.revealFile(hostId, resourcesCwd, path))) }
            : {})}
          {...(session && !lost && !readOnly && connected && resourcesCwd === session.cwd ? { onReload: reloadSessionResources } : {})}
          onRunPi={runPi}
          onOpenMarketplace={() => {
            setResourcesOpen(false);
            setMarketOpen(true);
          }}
          {...(hosts.length > 1
            ? {
                onCopy: (item, kind) => {
                  setResourcesOpen(false);
                  setCopyItem({ kind, name: item.name, path: item.path, fromPackage: item.fromPackage });
                },
                onCopyContext: (path) => {
                  setResourcesOpen(false);
                  setCopyContextPath(path);
                },
                onCopyPackage: (pkg) => {
                  setResourcesOpen(false);
                  setCopyPackage(pkg);
                },
              }
            : {})}
          onClose={() => setResourcesOpen(false)}
        />
      )}
      {active && copyItem && <CopyResourceDialog hosts={hosts} fromHostId={hostId} item={copyItem} onClose={() => setCopyItem(undefined)} />}
      {active && copyContextPath && (
        <ContextCopyDialog hosts={hosts} fromHostId={hostId} path={copyContextPath} onClose={() => setCopyContextPath(undefined)} />
      )}
      {active && copyPackage && (
        <PackageCopyDialog
          hosts={hosts}
          fromHostId={hostId}
          pkg={copyPackage}
          fromCwd={resourcesCwd}
          onRunPi={runPiOn}
          onClose={() => setCopyPackage(undefined)}
        />
      )}
      {active && playgroundOpen && (
        <PlaygroundPanel
          hosts={hosts}
          hostId={hostId}
          {...(resourcesCwd ? { cwd: resourcesCwd } : {})}
          onClose={() => setPlaygroundOpen(false)}
        />
      )}
      {active && inspectorOpen && session && (
        <EventInspector
          hostId={hostId}
          hostLabel={hostLabel}
          sessionId={session.sessionId}
          title={statusTitle}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      {active && marketOpen && (
        <MarketplacePanel
          hostId={hostId}
          hostLabel={hostLabel}
          {...(resourcesCwd ? { cwd: resourcesCwd } : {})}
          onRunPi={runPi}
          onClose={() => setMarketOpen(false)}
        />
      )}
      {active && sshHostsOpen && (
        <SshHostsDialog
          onClose={(changed) => {
            setSshHostsOpen(false);
            if (changed) reloadHosts();
          }}
        />
      )}
      {active && newFolderOpen && (
        <NewFolderDialog
          hostId={hostId}
          hostLabel={hostLabel}
          initialParent={cwd}
          onBrowse={async (current) => {
            if (osPicker) return window.piDesktop.pickDirectory();
            return new Promise<string | undefined>((resolve) => {
              browseForParent.current = resolve;
              setFolderBrowserOpen(true);
            });
          }}
          onCreated={(path, startSession) => {
            setNewFolderOpen(false);
            setCwd(path);
            if (startSession) void guard(() => openSession(path));
          }}
          onClose={() => setNewFolderOpen(false)}
        />
      )}
      {active && folderBrowserOpen && (
        <FolderBrowser
          hostId={hostId}
          hostLabel={hostLabel}
          initialPath={cwd}
          onPick={(path) => {
            setFolderBrowserOpen(false);
            if (browseForParent.current) {
              browseForParent.current(path);
              browseForParent.current = undefined;
            } else setCwd(path);
          }}
          onClose={() => {
            setFolderBrowserOpen(false);
            browseForParent.current?.(undefined);
            browseForParent.current = undefined;
          }}
        />
      )}
      {active && piManagerOpen && (
        <PiManager
          hosts={hosts}
          initialHostId={hostId}
          initialTab={piManagerTab}
          {...(resourcesCwd ? { projectCwd: resourcesCwd } : {})}
          onClose={() => {
            setPiManagerOpen(false);
            setPiManagerTab("status");
          }}
          onChanged={() => void piState.reload(true)}
          onRunInTerminal={(targetHost, command, title) => {
            setPiManagerOpen(false);
            const terminalKey = openTerminal({ hostId: targetHost, kind: "shell", initialInput: `${command}\r` }, title);
            if (targetHost === hostId) {
              setPiWatch({ terminalKey, hostId, before: piFingerprint(piState.status?.pi), until: Date.now() + PI_WATCH_LIMIT_MS });
            }
          }}
          onOAuthLogin={(targetHost, provider) => {
            setPiManagerOpen(false);
            openTerminal({ hostId: targetHost, kind: "pi", initialInput: `/login ${provider}\r` }, `pi 로그인 (${provider})`);
          }}
        />
      )}
      {active && palette && (
        <CommandPalette
          commands={paletteCommands(palette.history)}
          {...(palette.query ? { initialQuery: palette.query } : {})}
          onClose={() => {
            setPalette(undefined);
            focusComposer();
          }}
        />
      )}
    </div>
  );
}

function loadDraft(key: string | undefined): string {
  if (!key) return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(key: string | undefined, text: string): void {
  if (!key) return;
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // 저장하지 못해도 입력은 계속된다.
  }
}

function ConnectionBadge({ connection }: { connection: ReturnType<typeof useSession>["connection"] }) {
  switch (connection.status) {
    case "connected": {
      const { host } = connection;
      return (
        <span className="badge ok" title={`데몬 pid ${host.pid} · ${host.platform} · Node ${host.nodeVersion}`}>
          연결됨 · agent {host.agentVersion}
        </span>
      );
    }
    case "connecting":
      return <span className="badge">연결 중…</span>;
    case "idle":
      return <span className="badge">대기</span>;
    case "disconnected":
      return (
        <span className="badge bad" title={connection.reason}>
          연결 끊김 · 재시도 중
        </span>
      );
  }
}
