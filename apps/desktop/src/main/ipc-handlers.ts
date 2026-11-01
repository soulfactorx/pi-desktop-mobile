import {
  Methods,
  type AuthCheckResult,
  type DataBackupResult,
  type CustomProviderForm,
  type ModelsFileView,
  type ModelsProbeResult,
  type FsListDirResult,
  type ResourcesView,
  type ResourceImportResult,
  type ImportedInspectResult,
  type ResourceExportResult,
  type ModelsExportResult,
  type ModelsExportModelResult,
  type SettingsReadResult,
  type SettingsTarget,
  type PlaygroundRunParams,
  type PlaygroundRunResult,
  type PackageFilterChange,
  type PackageSetFilterParams,
  type PackageResourceItem,
  type ResourceImportParams,
  type ProjectTrustInfo,
  type ResourceFile,
  type ResourceKind,
  type ExtensionTemplate,
  type PackageCreateParams,
  type PackageCreateResult,
  type MyPackageInfo,
  type ResourceWriteResult,
  type FsSearchResult,
  type ProviderInfo,
  type PiLatest,
  type PiModelsResult,
  type PiStatus,
  type PiVersions,
  type PiUpdateResult,
  type PiUpdateTarget,
  type PiLocation,
  type PiResponse,
  type SessionAttachResult,
  type SessionHistoryParams,
  type SessionEventNotification,
  type SessionOpenParams,
  type SessionOpenResult,
  type SessionSummary,
  type StoredDeleteResult,
  type TrashEmptyResult,
  type TrashItem,
  type TrashRestoreResult,
  type StoredInspectResult,
  type StoredReadResult,
  type StoredSession,
} from "@pi-desktop/host-protocol";
import {
  IpcChannels,
  type AttachResult,
  type GithubCatalog,
  type GithubImportRequest,
  type ImportStatus,
  type GithubRepoRef,
  type ImportRecord,
  type CopyRecordInput,
  type OpenSessionRequest,
  type SshHostConfig,
  type TerminalOpenRequest,
} from "../shared/api";
import type { TerminalOwner, TerminalService } from "./terminal";
import { terminalCommand } from "./terminal-command";
import { devSessionOverrides } from "./dev-overrides";
import { LOCAL_HOST_ID, WSL_PREFIX, type HostManager, type HostManagerOptions } from "./host-manager";
import { SSH_PREFIX, sshExecutable } from "./ssh";
import type { SshHostStore } from "./ssh-hosts";
import { packageDetail, searchPackages } from "./marketplace";
import { browseRepo, downloadFiles, fetchText } from "./github-catalog";
import type { ImportStore } from "./imports";
import { compareCopy, exportKindOf, fileShas, type CopyStore } from "./copies";
import { collectInventory } from "./host-inventory";
import type { ActionLog } from "./action-log";
import { compareLocal, compareUpstream, projectCwdOf } from "./import-status";
import { hostPathForExplorer } from "./host-path";
import type { ReplayCollector } from "./replay-collector";


/**
 * 화면의 요청을 받는 처리기들 (shared/api.ts의 채널마다 하나).
 *
 * Electron 앱(main/index.ts, ipcMain)과 웹 서버(server/index.ts, WebSocket)가 같은 처리기를 쓴다.
 * 그래서 여기서는 Electron을 부르지 않는다. OS 대화상자·탐색기처럼 셸마다 다른 것은 deps로 받는다.
 */

/** 요청을 보낸 화면 하나 (Electron WebContents 또는 웹 서버의 WebSocket 연결). 터미널 출력을 그 화면에만 보낼 때 쓴다 */
export type Peer = TerminalOwner;

/** 채널에 처리기를 다는 곳. 처리기의 첫 인자는 요청을 보낸 화면이다 */
export interface Router {
  /** 요청/응답 (ipcMain.handle) */
  handle(channel: string, listener: (peer: Peer, ...args: any[]) => unknown): void;
  /** 응답 없는 메시지 (ipcMain.on) */
  on(channel: string, listener: (peer: Peer, ...args: any[]) => void): void;
}

export interface HandlerDeps {
  manager: HostManager;
  sshHosts: SshHostStore;
  imports: ImportStore;
  copies: CopyStore;
  actionLog: ActionLog;
  terminals: TerminalService;
  replays: ReplayCollector<SessionEventNotification>;
  /** 로컬 폴더 선택 대화상자. 없는 셸(웹)은 undefined를 돌려준다 */
  pickDirectory: () => Promise<string | undefined>;
  /** 파일 위치를 탐색기에서 보여준다. 못 하면 false */
  revealPath: (path: string) => boolean;
}

const replayKey = (hostId: string, sessionId: string) => `${hostId}::${sessionId}`;

type HostEventOptions = Omit<HostManagerOptions, "agentScript" | "agentVersion" | "sshHosts">;

/**
 * 호스트 연결의 알림을 화면들로 보낸다 (broadcast는 열린 화면 모두에 보낸다).
 * attach 중인 세션의 이벤트는 attach 결과에도 담는다. 같은 세션을 이미 보고 있는 다른 탭이 놓치지 않도록
 * 알림으로도 항상 보내고, attach하는 쪽은 결과를 먼저 적용한 뒤 순번으로 중복을 거른다 (replay-collector.ts).
 */
export function hostEventHandlers(
  broadcast: (channel: string, ...payload: unknown[]) => void,
  replays: ReplayCollector<SessionEventNotification>,
): HostEventOptions {
  return {
    onState: (hostId, state) => broadcast(IpcChannels.connectionChanged, hostId, state),
    onSessionEvent: (hostId, n) => {
      replays.capture(replayKey(hostId, n.sessionId), n);
      broadcast(IpcChannels.sessionEvent, hostId, n);
    },
    onSessionExit: (hostId, n) => broadcast(IpcChannels.sessionExit, hostId, n),
    onUiResolved: (hostId, n) => broadcast(IpcChannels.uiResolved, hostId, n),
    onStoredChanged: (hostId, n) => broadcast(IpcChannels.storedChanged, hostId, n),
    onExternalWrite: (hostId, n) => broadcast(IpcChannels.externalWrite, hostId, n),
    onWriterChanged: (hostId, n) => broadcast(IpcChannels.writerChanged, hostId, n),
    onFilesChanged: (hostId, n) => broadcast(IpcChannels.filesChanged, hostId, n),
    onPlaygroundOutput: (hostId, n) => broadcast(IpcChannels.playgroundOutput, hostId, n),
    onPiUpdateOutput: (hostId, n) => broadcast(IpcChannels.piUpdateOutput, hostId, n),
  };
}

export function registerHandlers(router: Router, deps: HandlerDeps): void {
  // 관리 작업은 작업 기록에 남긴다 (action-log.ts의 LOGGED에 있는 채널만).
  const { manager, sshHosts, imports, copies, actionLog, terminals } = deps;
  const handle = (channel: string, listener: (peer: Peer, ...args: any[]) => unknown) => router.handle(channel, actionLog.wrap(channel, listener));
  handle(IpcChannels.listActionLog, (_event, limit?: number) => actionLog.list(typeof limit === "number" ? limit : undefined));
  handle(IpcChannels.logAction, (_event, entry: { hostId: string; summary: string; detail?: string }) => {
    actionLog.add({ hostId: String(entry.hostId), summary: String(entry.summary), ...(entry.detail ? { detail: String(entry.detail) } : {}), ok: true });
  });
  const conn = (hostId: string) => manager.get(hostId);

  // 내장 터미널: pi는 데몬이 찾은 Pi와 그 실행 node로 띄운다.
  handle(IpcChannels.terminalOpen, async (peer, request: TerminalOpenRequest) => {
    const status = request.kind === "pi" ? await conn(request.hostId).request<PiStatus>(Methods.piStatus) : undefined;
    const runtime = status?.pi ? { pi: status.pi, nodePath: status.node.path } : undefined;
    const command = terminalCommand(
      {
        hostId: request.hostId,
        kind: request.kind,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.args ? { args: request.args } : {}),
        ...(sshTarget(request.hostId) ? { ssh: sshTarget(request.hostId)! } : {}),
      },
      runtime,
    );
    return { id: await terminals.open(peer, command, request.cols, request.rows), title: command.title };
  });
  router.on(IpcChannels.terminalWrite, (_event, id: string, data: string) => terminals.write(id, data));
  router.on(IpcChannels.terminalResize, (_event, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
  router.on(IpcChannels.terminalClose, (_event, id: string) => terminals.close(id));

  handle(IpcChannels.listHosts, () => manager.listHosts());
  const sshTarget = (hostId: string) => {
    const host = hostId.startsWith(SSH_PREFIX) ? sshHosts.get(hostId.slice(SSH_PREFIX.length)) : undefined;
    return host ? { executable: sshExecutable(), host } : undefined;
  };
  handle(IpcChannels.listSshHosts, () => sshHosts.list());
  handle(IpcChannels.saveSshHost, (_event, host: SshHostConfig, previousName: string | undefined) => {
    sshHosts.save(host, previousName);
    // 고친 호스트는 다음에 쓸 때 새 설정으로 다시 연결한다.
    if (previousName !== undefined) manager.forget(`${SSH_PREFIX}${previousName}`);
  });
  handle(IpcChannels.removeSshHost, (_event, name: string) => {
    sshHosts.remove(name);
    manager.forget(`${SSH_PREFIX}${name}`);
  });
  handle(IpcChannels.connectHost, (_event, hostId: string) => {
    // 연달아 실패해 멈춘 호스트를 사용자가 다시 고르면 한 번 더 붙어 본다.
    const connection = conn(hostId);
    const state = connection.current;
    if (state.status === "disconnected" && state.gaveUp) connection.reconnect();
    return connection.current;
  });
  handle(IpcChannels.reconnectHost, (_event, hostId: string) => conn(hostId).reconnect());
  handle(IpcChannels.replaceAgent, (_event, hostId: string) => conn(hostId).replaceAgent());
  handle(IpcChannels.locatePi, (_event, hostId: string) =>
    conn(hostId).request<PiLocation>(Methods.piLocate, hostId === LOCAL_HOST_ID ? { piCliPath: process.env.PI_DESKTOP_PI_CLI } : {}),
  );
  // 저장된 세션 파일 검사·읽기·감시 (팔로우 모드). Pi CLI 경로는 SDK를 불러올 때만 필요하다.
  const storedParams = (hostId: string, path: string) =>
    hostId === LOCAL_HOST_ID && process.env.PI_DESKTOP_PI_CLI ? { path, piCliPath: process.env.PI_DESKTOP_PI_CLI } : { path };
  handle(IpcChannels.inspectStored, (_event, hostId: string, path: string) =>
    conn(hostId).request<StoredInspectResult>(Methods.storedInspect, { path }),
  );
  handle(IpcChannels.deleteStored, (_event, hostId: string, path: string) =>
    conn(hostId).request<StoredDeleteResult>(Methods.storedDelete, { path }),
  );
  handle(IpcChannels.listTrash, (_event, hostId: string) => conn(hostId).request<TrashItem[]>(Methods.trashList));
  handle(IpcChannels.restoreTrash, async (_event, hostId: string, id: string) =>
    (await conn(hostId).request<TrashRestoreResult>(Methods.trashRestore, { id })).path,
  );
  handle(IpcChannels.emptyTrash, async (_event, hostId: string, ids?: string[]) =>
    (await conn(hostId).request<TrashEmptyResult>(Methods.trashEmpty, ids ? { ids } : {})).removed,
  );
  handle(IpcChannels.setArchived, async (_event, hostId: string, path: string, archived: boolean) => {
    await conn(hostId).request(Methods.archiveSet, { path, archived: archived === true });
  });
  handle(IpcChannels.readStored, (_event, hostId: string, path: string) =>
    conn(hostId).request<StoredReadResult>(Methods.storedRead, storedParams(hostId, path)),
  );
  handle(IpcChannels.watchStored, async (_event, hostId: string, path: string) => {
    await conn(hostId).request(Methods.storedWatch, { path });
  });
  // 스크립트가 끝날 때까지 기다린다 (제한 시간 + 여유).
  handle(IpcChannels.usageSummary, (_event, hostId: string, range: string) =>
    // 세션 파일을 모두 훑으므로 오래 걸릴 수 있다
    conn(hostId).request(Methods.usageSummary, { range }, 5 * 60_000),
  );
  handle(IpcChannels.playgroundRun, (_event, hostId: string, params: PlaygroundRunParams) =>
    conn(hostId).request<PlaygroundRunResult>(Methods.playgroundRun, params, (params.timeoutMs ?? 120_000) + 30_000),
  );
  handle(IpcChannels.playgroundStop, async (_event, hostId: string, runId: string) => {
    await conn(hostId).request(Methods.playgroundStop, { runId });
  });
  handle(IpcChannels.watchTree, async (_event, hostId: string, watchId: string, roots: string[]) => {
    await conn(hostId).request(Methods.filesWatchTree, { watchId, roots });
  });
  handle(IpcChannels.unwatchTree, async (_event, hostId: string, watchId: string) => {
    await conn(hostId).request(Methods.filesUnwatchTree, { watchId });
  });
  handle(IpcChannels.unwatchStored, async (_event, hostId: string, path: string) => {
    await conn(hostId).request(Methods.storedUnwatch, { path });
  });
  handle(IpcChannels.listHistory, (_event, hostId: string, cwd: string | undefined) => {
    const params: SessionHistoryParams = cwd ? { cwd } : {};
    // 개발용 덮어쓰기(격리된 Pi 설정)는 로컬 호스트에만 적용한다.
    if (hostId === LOCAL_HOST_ID) {
      const overrides = devSessionOverrides();
      if (overrides.piCliPath) params.piCliPath = overrides.piCliPath;
      const sessionDir = overrides.env?.PI_CODING_AGENT_SESSION_DIR;
      if (sessionDir) params.sessionDir = sessionDir;
    }
    return conn(hostId).request<StoredSession[]>(Methods.sessionHistory, params);
  });
  handle(IpcChannels.listSessions, (_event, hostId: string) =>
    conn(hostId).request<SessionSummary[]>(Methods.sessionList),
  );
  handle(IpcChannels.openSession, async (_event, hostId: string, request: OpenSessionRequest) => {
    // 개발용 덮어쓰기 값은 Windows 경로라서 로컬 호스트에만 적용한다.
    const overrides = hostId === LOCAL_HOST_ID ? devSessionOverrides() : {};
    const params: SessionOpenParams = { ...overrides, cwd: request.cwd };
    if (request.sessionFile) params.sessionFile = request.sessionFile;
    if (request.forkFrom) params.forkFrom = request.forkFrom;
    if (request.trust) params.trust = request.trust;
    if (request.createCwd) params.createCwd = true;
    const result = await conn(hostId).request<SessionOpenResult>(Methods.sessionOpen, params);
    return result.session;
  });
  handle(IpcChannels.attachSession, async (_event, hostId: string, sessionId: string, lastSeq: number) => {
    const key = replayKey(hostId, sessionId);
    const events = deps.replays.begin(key);
    try {
      const result = await conn(hostId).request<SessionAttachResult>(Methods.sessionAttach, { sessionId, lastSeq });
      const reply: AttachResult = { ...result, events };
      return reply;
    } finally {
      deps.replays.end(key, events);
    }
  });
  handle(IpcChannels.closeSession, (_event, hostId: string, sessionId: string) =>
    conn(hostId).request(Methods.sessionClose, { sessionId }),
  );
  handle(IpcChannels.claimWriter, async (_event, hostId: string, sessionId: string) => {
    await conn(hostId).request(Methods.sessionClaimWriter, { sessionId });
  });
  handle(IpcChannels.clearExternalWrite, async (_event, hostId: string, sessionId: string) => {
    await conn(hostId).request(Methods.sessionClearExternalWrite, { sessionId });
  });
  handle(
    IpcChannels.sendCommand,
    (_event, hostId: string, sessionId: string, command: Record<string, unknown>) =>
      // `!` 셸 명령은 끝나야 응답이 오므로 시간 제한을 두지 않는다. 멈추려면 abort_bash를 보낸다.
      // 트리 이동(/desktop:tree)은 요약하면 몇 분 걸릴 수 있다 (데몬이 10분에서 멈춘다).
      conn(hostId).request<PiResponse>(
        Methods.sessionSend,
        { sessionId, command },
        command.type === "bash" ? 0 : isTreePrompt(command) ? 11 * 60_000 : undefined,
      ),
  );
  handle(
    IpcChannels.sendRecord,
    async (_event, hostId: string, sessionId: string, record: Record<string, unknown>) => {
      await conn(hostId).request(Methods.sessionSend, { sessionId, command: record, noResponse: true });
    },
  );
  handle(IpcChannels.pickDirectory, () => deps.pickDirectory());
  handle(IpcChannels.piStatus, (_event, hostId: string) => conn(hostId).request<PiStatus>(Methods.piStatus));
  handle(IpcChannels.piLatest, (_event, hostId: string, force: boolean) =>
    conn(hostId).request<PiLatest>(Methods.piLatest, { force }),
  );
  handle(IpcChannels.piModels, (_event, hostId: string) => conn(hostId).request<PiModelsResult>(Methods.piModels));
  handle(IpcChannels.piUpdate, (_event, hostId: string, target: PiUpdateTarget, taskId: string, force: boolean) =>
    // 업데이트는 몇 분 걸릴 수 있어 응답 시간 제한을 두지 않는다 (데몬이 15분에서 멈춘다).
    conn(hostId).request<PiUpdateResult>(Methods.piUpdate, { target, taskId, force }, 0),
  );
  handle(IpcChannels.authProviders, (_event, hostId: string) =>
    conn(hostId).request<ProviderInfo[]>(Methods.authProviders),
  );
  handle(IpcChannels.authCheck, (_event, hostId: string, provider: string) =>
    conn(hostId).request<AuthCheckResult>(Methods.authCheck, { provider }),
  );
  // 키는 데몬으로만 넘기고 로그에 남기지 않는다.
  handle(IpcChannels.authSetApiKey, async (_event, hostId: string, provider: string, key: string) => {
    await conn(hostId).request(Methods.authSetApiKey, { provider, key });
  });
  handle(IpcChannels.authRemove, (_event, hostId: string, provider: string) =>
    conn(hostId).request<{ removed: boolean }>(Methods.authRemove, { provider }),
  );
  handle(IpcChannels.modelsRead, (_event, hostId: string) => conn(hostId).request<ModelsFileView>(Methods.modelsRead));
  handle(
    IpcChannels.modelsSaveProvider,
    async (_event, hostId: string, provider: CustomProviderForm, previousId: string | undefined) => {
      await conn(hostId).request(Methods.modelsSaveProvider, previousId ? { provider, previousId } : { provider });
    },
  );
  handle(IpcChannels.modelsRemoveProvider, (_event, hostId: string, id: string) =>
    conn(hostId).request<{ removed: boolean }>(Methods.modelsRemoveProvider, { id }),
  );
  handle(
    IpcChannels.modelsProbe,
    (_event, hostId: string, baseUrl: string, apiKey: string | undefined, providerId: string | undefined) =>
      conn(hostId).request<ModelsProbeResult>(Methods.modelsProbe, {
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(providerId ? { providerId } : {}),
      }),
  );
  // 백업은 데이터 크기에 따라 오래 걸릴 수 있어 시간 제한을 두지 않는다 (데몬의 tar가 10분에서 멈춘다).
  handle(IpcChannels.dataBackup, (_event, hostId: string) =>
    conn(hostId).request<DataBackupResult>(Methods.dataBackup, undefined, 0),
  );
  handle(IpcChannels.dataDelete, async (_event, hostId: string, confirm: string) => {
    await conn(hostId).request(Methods.dataDelete, { confirm }, 0);
  });
  handle(IpcChannels.piVersions, (_event, hostId: string) => conn(hostId).request<PiVersions>(Methods.piVersions));
  handle(IpcChannels.searchFiles, (_event, hostId: string, cwd: string, query: string) =>
    conn(hostId).request<FsSearchResult>(Methods.fsSearch, { cwd, query, limit: 30 }),
  );
  handle(IpcChannels.listDir, (_event, hostId: string, path: string | undefined) =>
    conn(hostId).request<FsListDirResult>(Methods.fsListDir, path ? { path } : {}),
  );
  handle(IpcChannels.makeDir, async (_event, hostId: string, parent: string, name: string) =>
    (await conn(hostId).request<{ path: string }>(Methods.fsMakeDir, { parent, name })).path,
  );
  // 패키지 경로 해석에 npm 조회가 끼어 느릴 수 있어 넉넉히 기다린다.
  handle(IpcChannels.listResources, (_event, hostId: string, cwd: string) =>
    conn(hostId).request<ResourcesView>(Methods.resourcesList, { cwd }, 120_000),
  );
  handle(IpcChannels.marketSearch, (_event, query: string, from: number) => searchPackages(String(query ?? ""), Number(from) || 0));
  handle(IpcChannels.marketDetail, (_event, name: string) => packageDetail(String(name)));
  handle(IpcChannels.githubBrowse, (_event, spec: string) => browseRepo(String(spec)));
  handle(IpcChannels.githubText, (_event, repo: GithubRepoRef & { sha: string }, path: string) => fetchText(repo, String(path)));
  handle(IpcChannels.modelsExport, (_event, hostId: string, id: string) =>
    conn(hostId).request<ModelsExportResult>(Methods.modelsExportProvider, { id }),
  );
  handle(
    IpcChannels.modelsImport,
    async (_event, hostId: string, id: string, provider: Record<string, unknown>, replace: boolean) => {
      await conn(hostId).request(Methods.modelsImportProvider, { id, provider, ...(replace ? { replace: true } : {}) });
    },
  );
  handle(IpcChannels.packageResources, (_event, hostId: string, cwd: string, source: string, scope: "user" | "project", overlay?: boolean) =>
    conn(hostId).request<PackageResourceItem[]>(Methods.packagesResources, { cwd, source, scope, ...(overlay ? { overlay: true } : {}) }, 120_000),
  );
  handle(
    IpcChannels.setPackageFilter,
    async (
      _event,
      hostId: string,
      cwd: string,
      source: string,
      scope: "user" | "project",
      changes: PackageFilterChange[],
      reset: boolean,
      set?: PackageSetFilterParams["set"],
      overlay?: boolean,
    ) => {
      await conn(hostId).request(
        Methods.packagesSetFilter,
        { cwd, source, scope, changes, ...(reset ? { reset: true } : {}), ...(set ? { set } : {}), ...(overlay ? { overlay: true } : {}) },
        60_000,
      );
    },
  );
  handle(IpcChannels.settingsRead, (_event, hostId: string, target?: SettingsTarget) =>
    conn(hostId).request<SettingsReadResult>(Methods.settingsRead, { ...target }),
  );
  handle(
    IpcChannels.settingsWrite,
    (_event, hostId: string, content: string, baseMtime: number | null, target?: SettingsTarget) =>
      conn(hostId).request<{ mtimeMs: number }>(Methods.settingsWrite, { ...target, content, baseMtime }),
  );
  handle(
    IpcChannels.settingsMerge,
    async (_event, hostId: string, values: Record<string, unknown>, remove?: string[], target?: SettingsTarget) => {
      await conn(hostId).request(Methods.settingsMerge, { ...target, values, ...(remove && remove.length > 0 ? { remove } : {}) });
    },
  );
  handle(IpcChannels.settingsSchema, (_event, hostId: string) =>
    conn(hostId).request<Record<string, unknown> | null>(Methods.settingsSchema),
  );
  handle(IpcChannels.modelsExportModel, (_event, hostId: string, providerId: string, modelId: string) =>
    conn(hostId).request<ModelsExportModelResult>(Methods.modelsExportModel, { providerId, modelId }),
  );
  handle(IpcChannels.modelsImportModel, async (_event, hostId: string, providerId: string, model: Record<string, unknown>, replace: boolean) => {
    await conn(hostId).request(Methods.modelsImportModel, { providerId, model, ...(replace ? { replace: true } : {}) });
  });
  handle(IpcChannels.exportResource, (_event, hostId: string, kind: "skill" | "prompt" | "extension", path: string) =>
    conn(hostId).request<ResourceExportResult>(Methods.resourcesExport, { kind, path }, 120_000),
  );
  handle(IpcChannels.importResourceFiles, (_event, hostId: string, params: ResourceImportParams) =>
    conn(hostId).request<ResourceImportResult>(Methods.resourcesImport, params, 120_000),
  );
  handle(IpcChannels.listImports, (_event, hostId: string) => imports.list(hostId));
  // 이 PC가 GitHub에서 받아 그 호스트의 데몬에 쓰게 하고, 쓴 뒤에 출처를 기록한다.
  /** 이 PC가 GitHub에서 받아 그 호스트 데몬에 쓰고 출처를 기록한다. replace면 이전 것을 백업하고 바꾼다 */
  const importFromGithub = async (request: GithubImportRequest, replace = false): Promise<ImportRecord> => {
    const { item, repo } = request;
    const files =
      item.kind === "skill"
        ? await downloadFiles(repo, item.dir, item.files)
        : await downloadFiles(repo, ".", [{ path: item.path, sha: item.sha, size: item.size }]);
    const written = await conn(request.hostId).request<ResourceImportResult>(
      Methods.resourcesImport,
      { cwd: request.cwd, kind: item.kind, scope: request.scope, name: request.name, files, ...(replace ? { replace: true } : {}) },
      120_000,
    );
    const record: ImportRecord = {
      hostId: request.hostId,
      kind: item.kind,
      name: request.name,
      scope: request.scope,
      target: written.target,
      source: { owner: repo.owner, repo: repo.repo, sha: repo.sha, path: item.kind === "skill" ? item.dir : item.path },
      files: Object.fromEntries(item.kind === "skill" ? item.files.map((f) => [f.path, f.sha]) : [[item.path, item.sha]]),
      importedAt: Date.now(),
    };
    imports.add(record);
    return record;
  };
  handle(IpcChannels.recordCopy, (_event, input: CopyRecordInput) => {
    copies.add(input);
  });
  // 사본(이 호스트)과 원본(복사해 온 호스트)을 다시 읽어 해시를 견준다. 원본 호스트가 닿지 않으면 unknown.
  handle(IpcChannels.copyStatus, (_event, hostId: string) =>
    Promise.all(
      copies.listTo(hostId).map(async (record) => {
        const status = await compareCopy(record, async (side) => {
          const [host, path] = side === "local" ? [record.toHostId, record.toPath] : [record.fromHostId, record.fromPath];
          const result = await conn(host).request<ResourceExportResult>(Methods.resourcesExport, { kind: exportKindOf(record.kind), path }, 20_000);
          return fileShas(result.files);
        });
        return { record, status };
      }),
    ),
  );
  handle(IpcChannels.hostInventory, (_event, hostId: string) =>
    collectInventory(hostId, (method, params, timeoutMs) => conn(hostId).request(method, params, timeoutMs)),
  );
  handle(IpcChannels.githubImport, (_event, request: GithubImportRequest) => importFromGithub(request));

  const requireRecord = (hostId: string, target: string) => {
    const record = imports.get(hostId, target);
    if (!record) throw new Error(`가져온 기록이 없습니다: ${target}`);
    return record;
  };
  // 저장소마다 한 번만 최신을 훑고, 항목마다 그 호스트의 파일 해시와 비교한다.
  handle(IpcChannels.importStatus, async (_event, hostId: string): Promise<ImportStatus[]> => {
    const records = imports.list(hostId);
    const latest = new Map<string, Promise<GithubCatalog>>();
    return Promise.all(
      records.map(async (record): Promise<ImportStatus> => {
        const status: ImportStatus = { target: record.target, local: "same", localChanged: [], upstream: "unknown", upstreamChanged: [] };
        try {
          const inspected = await conn(hostId).request<ImportedInspectResult>(Methods.resourcesInspectImported, {
            target: record.target,
            kind: record.kind,
          });
          Object.assign(status, compareLocal(record, inspected));
          const key = `${record.source.owner}/${record.source.repo}`;
          if (!latest.has(key)) latest.set(key, browseRepo(key));
          Object.assign(status, compareUpstream(record, await latest.get(key)!));
        } catch (e) {
          status.error = e instanceof Error ? e.message : String(e);
        }
        return status;
      }),
    );
  });
  handle(IpcChannels.importUpdate, async (_event, hostId: string, target: string): Promise<ImportRecord> => {
    const record = requireRecord(hostId, target);
    const catalog = await browseRepo(`${record.source.owner}/${record.source.repo}`);
    const repo = { owner: catalog.owner, repo: catalog.repo, sha: catalog.sha };
    const skill = record.kind === "skill" ? catalog.skills.find((s) => s.dir === record.source.path) : undefined;
    const prompt = record.kind === "prompt" ? catalog.prompts.find((p) => p.path === record.source.path) : undefined;
    if (!skill && !prompt) throw new Error("원본 저장소에서 이 항목이 사라졌습니다");
    const cwd = record.scope === "project" ? projectCwdOf(record.target) : "";
    return importFromGithub(
      {
        hostId,
        cwd,
        scope: record.scope,
        name: record.name,
        repo,
        item: skill ? { kind: "skill", dir: skill.dir, files: skill.files } : { kind: "prompt", path: prompt!.path, sha: prompt!.sha, size: prompt!.size },
      },
      true,
    );
  });
  handle(IpcChannels.importRemove, async (_event, hostId: string, target: string) => {
    const record = requireRecord(hostId, target);
    await conn(hostId).request(Methods.resourcesRemoveImported, { target: record.target, kind: record.kind });
    imports.remove(hostId, target);
  });
  handle(
    IpcChannels.importDiff,
    async (_event, hostId: string, target: string, path: string, upstreamSha: string): Promise<{ local: string; upstream: string }> => {
      const record = requireRecord(hostId, target);
      const local = await conn(hostId)
        .request<string>(Methods.resourcesReadImported, { target: record.target, kind: record.kind, path })
        .catch(() => "");
      const repoPath = record.kind === "prompt" ? record.source.path : record.source.path === "." ? path : `${record.source.path}/${path}`;
      const upstream = await fetchText({ owner: record.source.owner, repo: record.source.repo, sha: upstreamSha }, repoPath).catch(() => "");
      return { local, upstream };
    },
  );
  handle(IpcChannels.getTrust, (_event, hostId: string, cwd: string) =>
    conn(hostId).request<ProjectTrustInfo>(Methods.trustGet, { cwd }),
  );
  handle(IpcChannels.setTrust, (_event, hostId: string, cwd: string, decision: boolean | null) =>
    conn(hostId).request<ProjectTrustInfo>(Methods.trustSet, { cwd, decision }),
  );
  handle(IpcChannels.readResource, (_event, hostId: string, cwd: string, path: string) =>
    conn(hostId).request<ResourceFile>(Methods.resourcesRead, { cwd, path }),
  );
  handle(
    IpcChannels.writeResource,
    (_event, hostId: string, cwd: string, path: string, content: string, baseMtime: number | undefined) =>
      conn(hostId).request<ResourceWriteResult>(Methods.resourcesWrite, {
        cwd,
        path,
        content,
        ...(typeof baseMtime === "number" ? { baseMtime } : {}),
      }),
  );
  handle(
    IpcChannels.createResource,
    (_event, hostId: string, cwd: string, kind: ResourceKind, scope: "user" | "project", name: string, template?: ExtensionTemplate) =>
      conn(hostId).request<ResourceFile>(Methods.resourcesCreate, { cwd, kind, scope, name, ...(template ? { template } : {}) }),
  );
  handle(IpcChannels.createPackage, (_event, hostId: string, params: PackageCreateParams) =>
    conn(hostId).request<PackageCreateResult>(Methods.resourcesCreatePackage, params),
  );
  handle(IpcChannels.listMyPackages, (_event, hostId: string) => conn(hostId).request<MyPackageInfo[]>(Methods.resourcesListPackages));
  handle(IpcChannels.deleteMyPackage, (_event, hostId: string, folder: string) =>
    conn(hostId).request<{ backup: string }>(Methods.resourcesDeletePackage, { folder }),
  );
  handle(IpcChannels.deleteResource, (_event, hostId: string, path: string, kind: "prompt" | "skill" | "extension") =>
    conn(hostId).request<{ backup: string }>(Methods.resourcesDelete, { path, kind }),
  );
  handle(IpcChannels.revealFile, (_event, hostId: string, cwd: string, path: string) => {
    const target = hostPathForExplorer(hostId, cwd, path, WSL_PREFIX);
    return target ? deps.revealPath(target) : false;
  });
}

/** bridge 확장의 트리 이동 명령 (데몬 bridge.ts의 TREE_COMMAND) */
function isTreePrompt(command: Record<string, unknown>): boolean {
  return command.type === "prompt" && typeof command.message === "string" && command.message.startsWith("/desktop:tree ");
}
