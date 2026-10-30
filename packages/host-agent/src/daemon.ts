import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createJsonlReader,
  encodeJsonl,
  ErrorCodes,
  HOST_PROTOCOL_VERSION,
  JsonRpcError,
  JsonRpcPeer,
  Methods,
  Notifications,
  type DaemonStatus,
  type FsSearchParams,
  type FsSearchResult,
  type FsListDirParams,
  type FsMakeDirParams,
  type ResourcesListParams,
  type ProjectTrustInfo,
  type TrustSetParams,
  type ResourceCreateParams,
  type PackageCreateParams,
  type PackageCreateResult,
  type MyPackageInfo,
  type ResourceImportParams,
  type ResourceImportResult,
  type ImportedInspectResult,
  type ImportedTargetParams,
  type ResourceExportParams,
  type ResourceExportResult,
  type ResourceFile,
  type ResourcePathParams,
  type ResourceWriteParams,
  type ResourceWriteResult,
  type ResourcesView,
  type FsListDirResult,
  type HostInfo,
  type PiLatest,
  type PiLatestParams,
  type PiModelsResult,
  type PiLocateParams,
  type PiStatus,
  type PiVersions,
  type DataBackupResult,
  type DataDeleteParams,
  type AuthCheckResult,
  type AuthProviderParams,
  type AuthSetApiKeyParams,
  type ProviderInfo,
  type ModelsFileView,
  type ModelsProbeParams,
  type ModelsProbeResult,
  type ModelsExportResult,
  type ModelsImportParams,
  type ModelsExportModelResult,
  type ModelsImportModelParams,
  type SettingsMergeParams,
  type FilesWatchTreeParams,
  type PlaygroundRunParams,
  type PlaygroundRunResult,
  type SettingsTarget,
  type SettingsWriteParams,
  type PackageResourceItem,
  type PackageResourcesParams,
  type PackageSetFilterParams,
  type SettingsReadResult,
  type ModelsSaveParams,
  type PiUpdateParams,
  type PiUpdateResult,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionEventNotification,
  type SessionExitNotification,
  type SessionExternalWriteNotification,
  type SessionWriterChangedNotification,
  type WriterState,
  type SessionUiResolvedNotification,
  type SessionOpenParams,
  type SessionOpenResult,
  type SessionRef,
  type SessionSendParams,
  type SessionHistoryParams,
  type SessionSummary,
  type StoredDeleteResult,
  type StoredInspectResult,
  type StoredPathParams,
  type StoredReadResult,
  type StoredSession,
  type AgentCallParams,
  type ArchiveSetParams,
  type TrashEmptyParams,
  type TrashEmptyResult,
  type TrashItem,
  type TrashRestoreParams,
  type TrashRestoreResult,
} from "@pi-desktop/host-protocol";
import { agentHome, runDir, socketPath } from "./paths";
import { locatePi } from "./pi-locator";
import { latestPiVersion, piStatus, piVersions } from "./pi-status";
import { backupAgentDir, deleteAgentDir } from "./agent-data";
import { agentDirOf, checkAuth, isProviderId, listProviders, removeCredential, setApiKey } from "./auth-store";
import {
  exportModel,
  exportProvider,
  importModel,
  importProvider,
  probeEndpoint,
  readModelsFile,
  removeProvider,
  saveProvider,
  storedApiKey,
} from "./models-store";
import { mergeSettings, readSettings, readSettingsSchema, settingsFileFor, writeSettingsRaw } from "./settings-store";
import { listPackageResources, setPackageFilter, type PackageFilterSdk } from "./package-filters";
import { isUpdateTarget, runPiUpdate } from "./pi-update";
import { ensureBridge } from "./bridge";
import { listDirectories, makeDirectory } from "./dir-list";
import { listResources, type ResourceSdk } from "./resources";
import { projectTrust, setProjectTrust, trustArgs, type TrustSdk } from "./trust";
import { createResourceFile, defaultPackagesRoot, readResourceFile, writeResourceFile } from "./resource-files";
import { importResource } from "./resource-import";
import { deleteResource, inspectImported, moveToBackup, readImported, type DeletableKind } from "./import-manage";
import { emptyTrash, listTrash, moveToTrash, restoreFromTrash } from "./session-trash";
import { loadArchive, setArchived } from "./session-archive";
import { appApi } from "@pi-desktop/agent-kit/app-api";
import { exportResource } from "./resource-export";
import { FileIndex } from "./file-search";
import { FileWatcher } from "./file-watcher";
import { watchTree } from "./tree-watcher";
import { Playground } from "./playground";
import { listStoredSessions, loadPiSdk, readStoredSession } from "./pi-sdk";
import { listPiModels } from "./pi-models";
import { EXTENSION_TEMPLATES } from "./extension-templates";
import { createPackage, deleteMyPackage, listMyPackages } from "./package-scaffold";
import { createToken, serverHandshake, writeToken } from "./handshake";
import { AgentSession } from "./session";
import { AGENT_VERSION } from "./version";

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** 세션·클라이언트가 모두 없을 때 스스로 종료하기까지 기다리는 시간 (ms) */
  idleShutdownMs?: number;
  journalCapacity?: number;
  /** 종료할 때 호출 (기본: process.exit) */
  onShutdown?: () => void;
  /** 실행 중인 번들의 빌드 식별자 (version.ts agentBuildOf). 앱이 예전 데몬을 가리는 데 쓴다 */
  agentBuild?: string;
}

/** 연결된 앱 하나 */
interface Client {
  id: number;
  socket: Socket;
  peer: JsonRpcPeer;
  /** 이 클라이언트가 이벤트를 받고 있는 세션들 */
  attached: Set<string>;
  /** 이 클라이언트가 팔로우 중인 세션 파일과 감시 해제 함수 */
  watches: Map<string, () => void>;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;

/**
 * Host Agent 상주 데몬 (설계 §3.4).
 *
 * 호스트·사용자당 하나만 뜬다. 앱은 연결기(connect)를 거쳐 이 데몬의 소켓에 붙는다.
 * 세션(Pi 프로세스)은 데몬이 소유하므로 앱 연결이 끊겨도 계속 실행된다.
 */
export class AgentDaemon {
  private server: Server | undefined;
  private nextClientId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private shuttingDown = false;
  private readonly startedAt = Date.now();
  private readonly clients = new Set<Client>();
  private readonly sessions = new Map<string, AgentSession>();
  /** 세션별 입력 권한(writer)을 가진 연결 id (설계 §3.4). 없으면 아무도 없다 */
  private readonly writers = new Map<string, number>();
  private readonly files = new FileWatcher();
  private playground: Playground | undefined;
  /** 입력창 @ 파일 피커용 파일 목록 캐시 */
  private readonly fileIndex = new FileIndex();
  /** 한 호스트에서 업데이트는 한 번에 하나만 */
  private updating = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly idleShutdownMs: number;
  /** 연결 인증 토큰. listen에서 파일로 쓴 뒤 채워진다 */
  private tokenReady: Promise<string> = new Promise(() => {});

  constructor(private readonly options: DaemonOptions = {}) {
    this.env = options.env ?? process.env;
    this.idleShutdownMs =
      options.idleShutdownMs ?? (Number(this.env.PI_DESKTOP_IDLE_SHUTDOWN_MS) || DEFAULT_IDLE_SHUTDOWN_MS);
  }

  /**
   * 소켓을 열고 연결을 받기 시작한다.
   * 이미 다른 데몬이 듣고 있으면 `false`를 돌려준다 (연결기가 동시에 데몬을 띄운 경우).
   */
  async listen(): Promise<boolean> {
    const path = socketPath(this.env);
    // 로그 파일도 여기에 쓰므로 Windows에서도 만든다. 권한 제한은 POSIX 소켓 파일 보호용이다.
    mkdirSync(runDir(this.env), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(runDir(this.env), 0o700);

    // 연결 인증 토큰 (handshake.ts). 소켓을 연 뒤에 파일로 쓰므로, 그 사이에 온 연결은 쓸 때까지 기다린다.
    let tokenWritten: (token: string) => void = () => {};
    this.tokenReady = new Promise((resolve) => (tokenWritten = resolve));
    const server = createServer((socket) => this.acceptClient(socket));
    const result = await tryListen(server, path);
    if (result === "in-use") {
      // 다른 데몬이 살아 있는지, 아니면 죽은 데몬이 남긴 소켓 파일인지 확인한다.
      if (await isAlive(path)) return false;
      if (process.platform !== "win32") {
        await unlink(path).catch(() => {});
        if ((await tryListen(server, path)) !== "ok") return false;
      } else {
        return false;
      }
    }
    this.server = server;
    // 다른 데몬이 듣고 있을 때는 그 데몬의 토큰을 덮어쓰지 않도록, 소켓을 연 뒤에만 쓴다.
    const token = createToken();
    await writeToken(token, this.env);
    tokenWritten(token);
    this.log(`데몬 시작 pid=${process.pid} socket=${path}`);
    this.scheduleIdleCheck();
    return true;
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`데몬 종료: ${reason}`);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await Promise.allSettled([...this.sessions.values()].map((s) => s.stop()));
    for (const client of this.clients) {
      client.peer.close("데몬이 종료되었습니다");
      client.socket.destroy();
    }
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    (this.options.onShutdown ?? (() => process.exit(0)))();
  }

  status(): DaemonStatus {
    return {
      pid: process.pid,
      agentVersion: AGENT_VERSION,
      ...(this.options.agentBuild ? { agentBuild: this.options.agentBuild } : {}),
      startedAt: this.startedAt,
      clients: this.clients.size,
      sessions: this.sessionSummaries(),
      idleShutdownMs: this.idleShutdownMs,
    };
  }

  /**
   * 새 연결: 먼저 토큰으로 서로를 확인하고(handshake.ts), 통과하면 JSON-RPC 클라이언트로 받는다.
   * 인증 없는 예전 연결기는 같은 사용자만 닿는 POSIX 소켓에서만 받는다.
   */
  private acceptClient(socket: Socket): void {
    socket.on("error", () => {});
    void this.tokenReady
      .then((token) => serverHandshake(socket, token, process.platform !== "win32"))
      .then(
        ({ rest, legacy }) => {
          if (legacy) this.log("인증하지 않는 예전 연결기가 붙었습니다");
          this.startClient(socket, rest);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          // 살아 있는지만 보고 바로 끊는 연결(isAlive)은 남기지 않는다.
          if (!message.includes("끊겼습니다")) this.log(`연결 거절: ${message}`);
          socket.destroy();
        },
      );
  }

  private startClient(socket: Socket, rest: Buffer): void {
    const client: Client = {
      id: this.nextClientId++,
      socket,
      attached: new Set(),
      watches: new Map(),
      peer: new JsonRpcPeer({ send: (message) => socket.write(encodeJsonl(message)) }),
    };
    this.clients.add(client);
    this.scheduleIdleCheck();

    const reader = createJsonlReader((record) => client.peer.receive(record));
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => {
      client.peer.close();
      for (const off of client.watches.values()) off();
      client.watches.clear();
      this.clients.delete(client);
      // 끊긴 앱의 입력 권한은 비운다. 남은 앱 중 먼저 입력하는 쪽이 가져간다.
      for (const [sessionId, writer] of [...this.writers]) {
        if (writer === client.id) this.setWriter(sessionId, undefined);
      }
      this.scheduleIdleCheck();
    });

    this.registerHandlers(client);
    // 인증 줄 뒤에 붙어 온 기록부터 처리하고, 인증하며 멈춰 둔 소켓을 다시 흐르게 한다.
    if (rest.length > 0) reader.push(rest);
    socket.resume();
  }

  private registerHandlers(client: Client): void {
    const { peer } = client;

    peer.handle(Methods.hostInfo, (): HostInfo => ({
      protocolVersion: HOST_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      ...(this.options.agentBuild ? { agentBuild: this.options.agentBuild } : {}),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      pid: process.pid,
      homeDir: homedir(),
    }));

    peer.handle(Methods.piLocate, (params) =>
      locatePi({ piCliPath: (params as PiLocateParams | undefined)?.piCliPath, env: this.env }),
    );

    peer.handle(Methods.piStatus, (): Promise<PiStatus> => piStatus({ env: this.env }));

    peer.handle(Methods.piLatest, (params): Promise<PiLatest> =>
      latestPiVersion((params as PiLatestParams | undefined)?.force === true),
    );

    peer.handle(Methods.piVersions, (): Promise<PiVersions> => piVersions());

    peer.handle(Methods.piModels, async (): Promise<PiModelsResult> => {
      const pi = await locatePi({ env: this.env }).catch(() => undefined);
      if (!pi) return { models: [], error: "설치된 Pi를 찾지 못했습니다" };
      return listPiModels(pi, this.env);
    });

    peer.handle(Methods.dataBackup, (): Promise<DataBackupResult> =>
      backupAgentDir(agentDirOf(this.env), join(agentHome(this.env), "backups")),
    );

    peer.handle(Methods.dataDelete, async (params) => {
      const confirm = (params as Partial<DataDeleteParams> | undefined)?.confirm;
      if (typeof confirm !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, "confirm이 필요합니다");
      if ([...this.sessions.values()].some((s) => s.isRunning)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "실행 중인 세션이 있습니다. 모두 닫은 뒤 지우세요");
      }
      const agentDir = agentDirOf(this.env);
      const pi = await locatePi({ env: this.env }).catch(() => undefined);
      if (pi && isInside(pi.packageDir, agentDir)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "Pi가 이 데이터 폴더 안에 설치되어 있습니다. 먼저 Pi를 제거하세요");
      }
      await deleteAgentDir(agentDir, confirm);
      return null;
    });

    peer.handle(Methods.piUpdate, async (params): Promise<PiUpdateResult> => {
      const p = (params ?? {}) as Partial<PiUpdateParams>;
      if (!isUpdateTarget(p.target) || typeof p.taskId !== "string") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "target(self|extensions|all|models)과 taskId가 필요합니다");
      }
      if (this.updating) throw new JsonRpcError(ErrorCodes.InvalidParams, "이미 업데이트가 진행 중입니다");
      this.updating = true;
      try {
        const before = await locatePi({ env: this.env });
        const run = await runPiUpdate(before, p.target, {
          force: p.force === true,
          env: this.env,
          onOutput: (chunk) => peer.notify(Notifications.piUpdateOutput, { taskId: p.taskId, chunk }),
        });
        const after = await locatePi({ env: this.env }).catch(() => undefined);
        const result: PiUpdateResult = { ...run, versionBefore: before.version };
        if (after) result.versionAfter = after.version;
        return result;
      } finally {
        this.updating = false;
      }
    });

    peer.handle(Methods.authProviders, async (): Promise<ProviderInfo[]> => {
      const pi = await locatePi({ env: this.env }).catch(() => undefined);
      return listProviders(pi, agentDirOf(this.env));
    });

    peer.handle(Methods.authCheck, async (params): Promise<AuthCheckResult> => {
      const provider = requireProvider(params);
      return checkAuth(await locatePi({ env: this.env }), provider, this.env);
    });

    peer.handle(Methods.authSetApiKey, async (params) => {
      const provider = requireProvider(params);
      const key = (params as Partial<AuthSetApiKeyParams>).key;
      if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "키가 비었거나 줄바꿈이 있습니다");
      }
      await setApiKey(agentDirOf(this.env), provider, key.trim());
      return null;
    });

    peer.handle(Methods.authRemove, async (params) => {
      return { removed: await removeCredential(agentDirOf(this.env), requireProvider(params)) };
    });

    peer.handle(Methods.modelsRead, (): Promise<ModelsFileView> => readModelsFile(agentDirOf(this.env)));

    peer.handle(Methods.modelsSaveProvider, async (params) => {
      const p = (params ?? {}) as Partial<ModelsSaveParams>;
      const form = p.provider;
      if (!form || !isProviderId(form.id)) throw new JsonRpcError(ErrorCodes.InvalidParams, "올바른 프로바이더 ID가 필요합니다");
      if (typeof form.baseUrl !== "string" || !/^https?:\/\//.test(form.baseUrl.trim())) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "baseUrl은 http:// 또는 https://로 시작해야 합니다");
      }
      if (typeof form.api !== "string" || !form.api.trim()) throw new JsonRpcError(ErrorCodes.InvalidParams, "api가 필요합니다");
      if (!Array.isArray(form.models)) throw new JsonRpcError(ErrorCodes.InvalidParams, "models가 필요합니다");
      if (p.previousId !== undefined && !isProviderId(p.previousId)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "올바르지 않은 원래 ID입니다");
      }
      await saveProvider(agentDirOf(this.env), form, p.previousId);
      return null;
    });

    peer.handle(Methods.modelsRemoveProvider, async (params) => ({
      removed: await removeProvider(agentDirOf(this.env), requireId(params)),
    }));

    // 다른 호스트로 옮기는 프로바이더 (설계 §5.9). 오류 문구는 사용자에게 그대로 보인다.
    peer.handle(Methods.modelsExportProvider, (params): Promise<ModelsExportResult> =>
      exportProvider(agentDirOf(this.env), requireId(params)).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      }),
    );

    peer.handle(Methods.modelsExportModel, (params): Promise<ModelsExportModelResult> => {
      const p = requireStrings(params, ["providerId", "modelId"]) as { providerId: string; modelId: string };
      return exportModel(agentDirOf(this.env), p.providerId, p.modelId).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
    });

    peer.handle(Methods.modelsImportModel, async (params) => {
      const p = (params ?? {}) as Partial<ModelsImportModelParams>;
      if (typeof p.providerId !== "string" || !p.model || typeof p.model !== "object") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "providerId와 model이 필요합니다");
      }
      await importModel(agentDirOf(this.env), p.providerId, p.model, p.replace === true).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
      return null;
    });

    peer.handle(Methods.modelsImportProvider, async (params) => {
      const p = (params ?? {}) as Partial<ModelsImportParams>;
      if (typeof p.id !== "string" || !p.provider || typeof p.provider !== "object") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "id와 provider가 필요합니다");
      }
      await importProvider(agentDirOf(this.env), p.id, p.provider, p.replace === true).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
      return null;
    });

    const packageParams = (params: unknown): PackageResourcesParams => {
      const p = requireStrings(params, ["source", "scope"]) as unknown as PackageResourcesParams;
      if (p.scope !== "user" && p.scope !== "project") throw new JsonRpcError(ErrorCodes.InvalidParams, "scope는 user·project여야 합니다");
      // 사용자 범위는 작업 폴더가 없어도 된다 (데이터 폴더를 쓴다). 프로젝트 범위는 있어야 한다.
      if (typeof p.cwd !== "string" || !p.cwd) {
        if (p.scope === "project" || p.overlay === true) throw new JsonRpcError(ErrorCodes.InvalidParams, "프로젝트 범위에는 cwd가 필요합니다");
        return { ...p, cwd: agentDirOf(this.env) };
      }
      return p;
    };
    const filterSdk = async () => (await loadPiSdk(await locatePi({ env: this.env }))) as unknown as PackageFilterSdk;

    peer.handle(Methods.packagesResources, async (params): Promise<PackageResourceItem[]> => {
      const p = packageParams(params);
      return listPackageResources(await filterSdk(), p.cwd, agentDirOf(this.env), p.source, p.scope, p.overlay === true).catch(asInvalid);
    });

    peer.handle(Methods.packagesSetFilter, async (params) => {
      const p = packageParams(params) as PackageSetFilterParams;
      if (!Array.isArray(p.changes)) throw new JsonRpcError(ErrorCodes.InvalidParams, "changes는 배열이어야 합니다");
      const set = (params as Partial<PackageSetFilterParams>).set;
      if (set !== undefined && (typeof set !== "object" || Object.values(set).some((v) => !Array.isArray(v) || v.some((e) => typeof e !== "string")))) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "set은 종류별 문자열 배열이어야 합니다");
      }
      await setPackageFilter(await filterSdk(), p.cwd, agentDirOf(this.env), p).catch(asInvalid);
      return null;
    });

    // 범위에 맞는 settings.json. 프로젝트 범위는 작업 폴더가 있어야 한다.
    const settingsFile = (params: unknown): string => {
      const p = (params ?? {}) as SettingsTarget;
      if (p.scope !== undefined && p.scope !== "user" && p.scope !== "project") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "scope는 user·project여야 합니다");
      }
      try {
        return settingsFileFor(p.scope, agentDirOf(this.env), typeof p.cwd === "string" ? p.cwd : undefined);
      } catch (e) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      }
    };

    peer.handle(Methods.settingsRead, (params): Promise<SettingsReadResult> => readSettings(settingsFile(params)));

    peer.handle(Methods.settingsWrite, async (params) => {
      const p = (params ?? {}) as Partial<SettingsWriteParams>;
      if (typeof p.content !== "string" || !(p.baseMtime === null || typeof p.baseMtime === "number")) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "content와 baseMtime이 필요합니다");
      }
      return writeSettingsRaw(settingsFile(params), p.content, p.baseMtime).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
    });

    peer.handle(Methods.settingsSchema, async () => readSettingsSchema(await locatePi({ env: this.env })));

    peer.handle(Methods.settingsMerge, async (params) => {
      const p = (params ?? {}) as Partial<SettingsMergeParams>;
      if (!p.values || typeof p.values !== "object" || Array.isArray(p.values)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "values가 필요합니다");
      }
      if (p.remove !== undefined && (!Array.isArray(p.remove) || p.remove.some((k) => typeof k !== "string"))) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "remove는 문자열 배열이어야 합니다");
      }
      await mergeSettings(settingsFile(params), p.values, p.remove).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
      return null;
    });

    peer.handle(Methods.modelsProbe, async (params): Promise<ModelsProbeResult> => {
      const p = (params ?? {}) as Partial<ModelsProbeParams>;
      if (typeof p.baseUrl !== "string" || !/^https?:\/\//.test(p.baseUrl.trim())) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "baseUrl은 http:// 또는 https://로 시작해야 합니다");
      }
      const key =
        p.apiKey !== undefined
          ? p.apiKey
          : isProviderId(p.providerId)
            ? await storedApiKey(agentDirOf(this.env), p.providerId)
            : undefined;
      return probeEndpoint(p.baseUrl.trim(), key, this.env);
    });

    peer.handle(Methods.sessionOpen, async (params): Promise<SessionOpenResult> => {
      const p = params as SessionOpenParams;
      if (!p?.cwd) throw new JsonRpcError(ErrorCodes.InvalidParams, "cwd가 필요합니다");
      if (p.sessionFile && p.forkFrom) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "sessionFile과 forkFrom은 함께 줄 수 없습니다");
      }
      // 지워진 작업 폴더를 다시 만들어 달라는 요청이면 먼저 만든다 (세션 파일의 폴더가 비워진 /tmp였을 때 등).
      if (p.createCwd) {
        await mkdir(p.cwd, { recursive: true }).catch((e: unknown) => {
          throw new JsonRpcError(ErrorCodes.InvalidParams, `작업 폴더를 만들지 못했습니다: ${p.cwd} (${e instanceof Error ? e.message : String(e)})`);
        });
      }
      // 없는 폴더로 spawn하면 Windows는 "node.exe ENOENT"처럼 엉뚱한 오류를 내므로 미리 확인한다.
      const cwdStat = await stat(p.cwd).catch(() => undefined);
      if (!cwdStat?.isDirectory()) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, `작업 폴더를 찾을 수 없습니다: ${p.cwd}`);
      }
      const pi = await locatePi({ piCliPath: p.piCliPath, env: this.env });
      // 리소스 다시 불러오기용 bridge 확장을 넣는다 (설계 §5.3). 문제를 조사할 때는 PI_DESKTOP_NO_BRIDGE=1로 끈다.
      const bridge = this.env.PI_DESKTOP_NO_BRIDGE ? undefined : await ensureBridge(join(agentHome(this.env), "bridge"));
      const session = new AgentSession({
        cwd: p.cwd,
        pi,
        // 관리형 설치가 자체 Node를 가지고 있으면 그 node로, 아니면 데몬의 node로 실행한다.
        nodePath: pi.nodePath ?? process.execPath,
        sessionFile: p.sessionFile,
        forkFrom: p.forkFrom,
        piArgs: [...(p.piArgs ?? []), ...trustArgs(p.trust), ...(bridge ? ["-e", bridge] : [])],
        env: { ...this.env, ...pi.env, ...p.env },
        journalCapacity: this.options.journalCapacity ?? (Number(this.env.PI_DESKTOP_JOURNAL_CAPACITY) || undefined),
        files: this.files,
        externalWriteGraceMs: Number(this.env.PI_DESKTOP_EXTERNAL_WRITE_GRACE_MS) || undefined,
      });
      this.sessions.set(session.id, session);
      this.writers.set(session.id, client.id); // 연 앱이 입력 권한을 가진다
      this.wireSession(session);
      try {
        await session.start();
      } catch (error) {
        this.sessions.delete(session.id);
        this.writers.delete(session.id);
        await session.stop().catch(() => {});
        throw error;
      }
      this.log(`세션 시작 ${session.id} cwd=${p.cwd} pi=${pi.version}`);
      this.scheduleIdleCheck();
      return { session: session.summary() };
    });

    peer.handle(Methods.sessionList, (): SessionSummary[] => this.sessionSummaries());

    peer.handle(Methods.storedInspect, async (params): Promise<StoredInspectResult> => {
      const { path } = requirePath(params);
      const info = await stat(path).catch(() => undefined);
      const owner = [...this.sessions.values()].find((s) => s.isRunning && s.summary().sessionFile === path);
      const result: StoredInspectResult = {
        path,
        exists: Boolean(info?.isFile()),
        size: info?.size ?? 0,
        modified: info?.mtimeMs ?? 0,
      };
      if (owner) result.ownedBy = owner.id;
      return result;
    });

    peer.handle(Methods.storedDelete, async (params): Promise<StoredDeleteResult> => {
      const { path } = requirePath(params);
      // 실행 중인 Pi가 쓰는 파일을 옮기면 Pi가 다시 만들어 쓰므로, 화면이 먼저 닫게 한다.
      if ([...this.sessions.values()].some((s) => s.isRunning && s.summary().sessionFile === path)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "실행 중인 세션입니다. 먼저 닫은 뒤 지우세요");
      }
      const result = await moveToTrash(path, agentHome(this.env)).catch(invalidParams);
      if (result.backup) this.log(`세션 파일 삭제 ${path} → ${result.backup}`);
      // 지운 세션은 아카이브에서도 뺀다 (되살리면 목록에 다시 보인다)
      await setArchived(agentHome(this.env), path, false);
      return result;
    });

    // 휴지통 (설계 DESIGN-APPS.md §3.2). 예전 삭제가 남긴 백업은 Pi 기본 규칙으로 원래 자리를 계산한다
    peer.handle(Methods.trashList, (): Promise<TrashItem[]> => listTrash(agentHome(this.env), agentDirOf(this.env)));

    peer.handle(Methods.trashRestore, async (params): Promise<TrashRestoreResult> => {
      const p = params as TrashRestoreParams | undefined;
      if (!p?.id) throw new JsonRpcError(ErrorCodes.InvalidParams, "id가 필요합니다");
      const path = await restoreFromTrash(agentHome(this.env), p.id, agentDirOf(this.env)).catch(invalidParams);
      this.log(`휴지통에서 되살림 ${p.id} → ${path}`);
      return { path };
    });

    peer.handle(Methods.trashEmpty, async (params): Promise<TrashEmptyResult> => {
      const p = (params ?? {}) as TrashEmptyParams;
      const removed = await emptyTrash(agentHome(this.env), p.ids).catch(invalidParams);
      this.log(`휴지통 비움 ${removed}개`);
      return { removed };
    });

    // 에이전트 앱의 데이터 (설계 DESIGN-APPS.md §4 Agent ③). 데몬 홈이 Agent 홈이고 그 아래 data/가 agent-kit 상태 폴더다.
    // Pi Desktop의 데몬에서는 부르지 않는다
    peer.handle(Methods.agentCall, async (params): Promise<unknown> => {
      const p = params as AgentCallParams | undefined;
      if (!p?.name || typeof p.name !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, "name이 필요합니다");
      const home = agentHome(this.env);
      const api = appApi({
        home,
        dataDir: this.env.PI_DESKTOP_AGENT_DATA || join(home, "data"),
        locatePi: (piCliPath) => locatePi({ piCliPath, env: this.env }),
      });
      const fn = Object.hasOwn(api, p.name) ? api[p.name] : undefined;
      if (!fn) throw new JsonRpcError(ErrorCodes.InvalidParams, `모르는 에이전트 함수입니다: ${p.name}`);
      const result = await fn(...(Array.isArray(p.args) ? p.args : [])).catch(invalidParams);
      return result === undefined ? null : result;
    });

    peer.handle(Methods.archiveSet, async (params): Promise<null> => {
      const p = params as ArchiveSetParams | undefined;
      if (!p?.path || typeof p.archived !== "boolean") throw new JsonRpcError(ErrorCodes.InvalidParams, "path와 archived가 필요합니다");
      await setArchived(agentHome(this.env), p.path, p.archived);
      return null;
    });

    peer.handle(Methods.storedRead, async (params): Promise<StoredReadResult> => {
      const p = requirePath(params);
      const pi = await locatePi({ piCliPath: p.piCliPath, env: this.env });
      return readStoredSession(await loadPiSdk(pi), p.path);
    });

    // 팔로우 모드: 다른 프로그램이 쓰는 세션 파일의 변경을 이 앱에 알린다. 앱이 끊기면 함께 멈춘다.
    peer.handle(Methods.storedWatch, (params) => {
      const { path } = requirePath(params);
      if (!client.watches.has(path)) {
        client.watches.set(path, this.files.watch(path, (change) => peer.notify(Notifications.storedChanged, change)));
      }
      return null;
    });

    // SDK Playground: 이 호스트의 Pi SDK로 스크립트를 실행하고 출력을 이 앱에만 알린다.
    peer.handle(Methods.playgroundRun, async (params): Promise<PlaygroundRunResult> => {
      const p = (params ?? {}) as Partial<PlaygroundRunParams>;
      if (typeof p.runId !== "string" || !p.runId || typeof p.code !== "string") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "runId와 code가 필요합니다");
      }
      this.playground ??= new Playground(join(agentHome(this.env), "playground"));
      const pi = await locatePi({ env: this.env });
      const runId = p.runId;
      const playground = this.playground;
      // 앱이 끊기면 실행 중인 스크립트도 멈춘다.
      client.watches.set(`play:${runId}`, () => playground.stop(runId));
      return playground
        .run(
          pi,
          { runId, code: p.code, ...(typeof p.cwd === "string" && p.cwd ? { cwd: p.cwd } : {}), ...(typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {}) },
          { env: this.env, onOutput: (stream, text) => peer.notify(Notifications.playgroundOutput, { runId, stream, text }) },
        )
        .catch((e: unknown) => {
          throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
        })
        .finally(() => client.watches.delete(`play:${runId}`));
    });

    peer.handle(Methods.playgroundStop, (params) => {
      const runId = (params as { runId?: unknown } | undefined)?.runId;
      if (typeof runId !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, "runId가 필요합니다");
      return { stopped: this.playground?.stop(runId) ?? false };
    });

    // Extension Dev Mode: 확장 파일·폴더를 감시한다. 앱이 끊기면 함께 멈춘다 (client.watches에 tree:<id>로 둔다).
    peer.handle(Methods.filesWatchTree, (params) => {
      const p = (params ?? {}) as Partial<FilesWatchTreeParams>;
      if (typeof p.watchId !== "string" || !p.watchId || !Array.isArray(p.roots) || p.roots.some((r) => typeof r !== "string")) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "watchId와 roots(문자열 배열)가 필요합니다");
      }
      const key = `tree:${p.watchId}`;
      client.watches.get(key)?.();
      const watchId = p.watchId;
      client.watches.set(key, watchTree(p.roots, (paths) => peer.notify(Notifications.filesChanged, { watchId, paths })));
      return null;
    });

    peer.handle(Methods.filesUnwatchTree, (params) => {
      const watchId = (params as { watchId?: unknown } | undefined)?.watchId;
      if (typeof watchId !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, "watchId가 필요합니다");
      client.watches.get(`tree:${watchId}`)?.();
      client.watches.delete(`tree:${watchId}`);
      return null;
    });

    peer.handle(Methods.storedUnwatch, (params) => {
      const { path } = requirePath(params);
      client.watches.get(path)?.();
      client.watches.delete(path);
      return null;
    });

    peer.handle(Methods.sessionHistory, async (params): Promise<StoredSession[]> => {
      const p = (params ?? {}) as SessionHistoryParams;
      const pi = await locatePi({ piCliPath: p.piCliPath, env: this.env });
      const [sessions, archive] = await Promise.all([listStoredSessions(await loadPiSdk(pi), p), loadArchive(agentHome(this.env))]);
      for (const session of sessions) if (archive[session.path] !== undefined) session.archived = true;
      return sessions;
    });

    peer.handle(Methods.sessionAttach, (params): SessionAttachResult => {
      const p = params as SessionAttachParams;
      const session = this.requireSession(p?.sessionId);
      // 재생과 구독 등록 사이에 다른 이벤트가 끼지 않도록 동기적으로 처리한다.
      const { entries, truncated } = session.journal.since(Math.max(0, p.lastSeq ?? 0));
      for (const entry of entries) {
        const notification: SessionEventNotification = { sessionId: session.id, ...entry };
        peer.notify(Notifications.sessionEvent, notification);
      }
      client.attached.add(session.id);
      // 아무도 입력 권한이 없으면 붙은 앱이 가져간다 (다른 앱들에도 알린다).
      if (!this.writers.has(session.id)) this.setWriter(session.id, client.id);
      const first = entries[0];
      const last = entries[entries.length - 1];
      return {
        session: session.summary(),
        truncated,
        replayed: first && last ? { fromSeq: first.seq, toSeq: last.seq } : null,
        pendingUi: session.dialogs.ids(),
        writer: this.writerState(client, session.id),
      };
    });

    peer.handle(Methods.sessionDetach, (params) => {
      client.attached.delete((params as SessionRef)?.sessionId);
      return null;
    });

    peer.handle(Methods.sessionSend, async (params) => {
      const p = params as SessionSendParams;
      const session = this.requireSession(p?.sessionId);
      if (!p.command || typeof p.command !== "object") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "command가 필요합니다");
      }
      if (!isReadOnlyCommand(p.command)) this.requireWriter(client, session.id);
      if (p.noResponse) {
        session.sendRaw(p.command);
        return null;
      }
      return session.send(p.command);
    });

    peer.handle(Methods.sessionClose, async (params) => {
      const session = this.requireSession((params as SessionRef)?.sessionId);
      // 닫으면 Pi가 끝나 다른 앱의 작업도 끝나므로 입력 권한이 있어야 한다.
      this.requireWriter(client, session.id);
      this.sessions.delete(session.id);
      this.writers.delete(session.id);
      await session.stop();
      for (const c of this.clients) c.attached.delete(session.id);
      this.log(`세션 닫음 ${session.id}`);
      this.scheduleIdleCheck();
      return null;
    });

    peer.handle(Methods.sessionClaimWriter, (params) => {
      const session = this.requireSession((params as SessionRef)?.sessionId);
      this.setWriter(session.id, client.id);
      return { writer: "you" satisfies WriterState };
    });

    peer.handle(Methods.sessionClearExternalWrite, (params) => {
      this.requireSession((params as SessionRef)?.sessionId).clearExternalWrite();
      return null;
    });

    peer.handle(Methods.fsSearch, (params): Promise<FsSearchResult> => {
      const p = (params ?? {}) as Partial<FsSearchParams>;
      if (typeof p.cwd !== "string" || !p.cwd) throw new JsonRpcError(ErrorCodes.InvalidParams, "cwd가 필요합니다");
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 200) : 50;
      return this.fileIndex.search(p.cwd, typeof p.query === "string" ? p.query : "", limit);
    });

    peer.handle(Methods.resourcesList, async (params): Promise<ResourcesView> => {
      const cwd = (params as Partial<ResourcesListParams> | undefined)?.cwd;
      if (typeof cwd !== "string" || !cwd) throw new JsonRpcError(ErrorCodes.InvalidParams, "cwd가 필요합니다");
      const pi = await locatePi({ env: this.env });
      const sdk = (await loadPiSdk(pi)) as unknown as ResourceSdk;
      return listResources(sdk, cwd, agentDirOf(this.env)).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
    });

    // 리소스 파일 오류는 사용자에게 보여 줄 문구이므로 InvalidParams로 그대로 넘긴다.
    const asInvalid = (e: unknown): never => {
      throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
    };

    peer.handle(Methods.resourcesImport, (params): Promise<ResourceImportResult> => {
      const p = requireStrings(params, ["cwd", "kind", "scope", "name"]) as unknown as ResourceImportParams;
      if (!["skill", "prompt", "extension"].includes(p.kind) || !["user", "project"].includes(p.scope) || !Array.isArray(p.files)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "kind는 skill·prompt·extension, scope는 user·project, files는 배열이어야 합니다");
      }
      return importResource(p, p.cwd, agentDirOf(this.env), importBackups()).catch(asInvalid);
    });

    // 가져온 항목의 이전 내용·제거한 것은 앱 홈에 둔다 (바로 지우지 않는다).
    const importBackups = () => join(agentHome(this.env), "resource-backups", "imports");
    const importedTarget = (params: unknown): ImportedTargetParams => {
      const p = requireStrings(params, ["target", "kind"]) as unknown as ImportedTargetParams;
      if (p.kind !== "skill" && p.kind !== "prompt") throw new JsonRpcError(ErrorCodes.InvalidParams, "kind는 skill·prompt여야 합니다");
      return p;
    };

    peer.handle(Methods.resourcesExport, (params): Promise<ResourceExportResult> => {
      const p = requireStrings(params, ["kind", "path"]) as unknown as ResourceExportParams;
      if (!["skill", "prompt", "extension"].includes(p.kind)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "kind는 skill·prompt·extension이어야 합니다");
      }
      return exportResource(p.kind, p.path).catch(asInvalid);
    });

    peer.handle(Methods.resourcesInspectImported, (params): Promise<ImportedInspectResult> => {
      const p = importedTarget(params);
      return inspectImported(p.target, p.kind, agentDirOf(this.env)).catch(asInvalid);
    });

    peer.handle(Methods.resourcesReadImported, (params): Promise<string> => {
      const p = importedTarget(params);
      const path = (params as { path?: unknown }).path;
      return readImported(p.target, p.kind, typeof path === "string" ? path : "", agentDirOf(this.env)).catch(asInvalid);
    });

    peer.handle(Methods.resourcesDelete, async (params): Promise<{ backup: string }> => {
      const { path, kind } = (params ?? {}) as { path?: unknown; kind?: unknown };
      if (typeof path !== "string" || (kind !== "prompt" && kind !== "skill" && kind !== "extension")) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "path와 kind(prompt|skill|extension)가 필요합니다");
      }
      const backups = join(agentHome(this.env), "resource-backups", "deleted");
      return { backup: await deleteResource(path, kind as DeletableKind, agentDirOf(this.env), backups).catch(asInvalid) };
    });

    peer.handle(Methods.resourcesRemoveImported, async (params): Promise<{ backup: string }> => {
      const p = importedTarget(params);
      return { backup: await moveToBackup(p.target, p.kind, agentDirOf(this.env), importBackups()).catch(asInvalid) };
    });

    peer.handle(Methods.trustGet, async (params): Promise<ProjectTrustInfo> => {
      const { cwd } = requireStrings(params, ["cwd"]) as { cwd: string };
      const sdk = (await loadPiSdk(await locatePi({ env: this.env }))) as unknown as TrustSdk;
      return projectTrust(sdk, cwd, agentDirOf(this.env));
    });

    peer.handle(Methods.trustSet, async (params): Promise<ProjectTrustInfo> => {
      const p = requireStrings(params, ["cwd"]) as unknown as TrustSetParams;
      if (p.decision !== null && typeof p.decision !== "boolean") {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "decision은 true·false·null이어야 합니다");
      }
      const sdk = (await loadPiSdk(await locatePi({ env: this.env }))) as unknown as TrustSdk;
      return setProjectTrust(sdk, p.cwd, agentDirOf(this.env), p.decision);
    });

    peer.handle(Methods.resourcesRead, (params): Promise<ResourceFile> => {
      const p = requireStrings(params, ["cwd", "path"]) as unknown as ResourcePathParams;
      return readResourceFile(p.path, p.cwd, agentDirOf(this.env)).catch(asInvalid);
    });

    peer.handle(Methods.resourcesWrite, (params): Promise<ResourceWriteResult> => {
      const p = requireStrings(params, ["cwd", "path", "content"]) as unknown as ResourceWriteParams;
      const base = typeof p.baseMtime === "number" ? p.baseMtime : undefined;
      const backups = join(agentHome(this.env), "resource-backups");
      return writeResourceFile(p.path, p.content, base, p.cwd, agentDirOf(this.env), backups).catch(asInvalid);
    });

    peer.handle(Methods.resourcesCreatePackage, (params): Promise<PackageCreateResult> => {
      const p = (params ?? {}) as Partial<PackageCreateParams>;
      const include = Array.isArray(p.include) ? p.include : [];
      const valid =
        typeof p.name === "string" &&
        (p.extensionTemplate === undefined || Object.hasOwn(EXTENSION_TEMPLATES, p.extensionTemplate)) &&
        include.every((i) => typeof i?.path === "string" && ["prompt", "skill", "extension"].includes(i?.kind));
      if (!valid) throw new JsonRpcError(ErrorCodes.InvalidParams, "name, extensionTemplate, include(path·kind)가 올바르지 않습니다");
      return createPackage(
        { name: p.name!.trim(), ...(p.description ? { description: p.description } : {}), ...(p.extensionTemplate ? { extensionTemplate: p.extensionTemplate } : {}), include },
        agentDirOf(this.env),
        defaultPackagesRoot(),
      ).catch(asInvalid);
    });

    peer.handle(Methods.resourcesListPackages, (): Promise<MyPackageInfo[]> => listMyPackages(defaultPackagesRoot()));

    peer.handle(Methods.resourcesDeletePackage, async (params): Promise<{ backup: string }> => {
      const { folder } = requireStrings(params, ["folder"]) as { folder: string };
      const backups = join(agentHome(this.env), "resource-backups", "packages");
      return { backup: await deleteMyPackage(folder, defaultPackagesRoot(), backups).catch(asInvalid) };
    });

    peer.handle(Methods.resourcesCreate, (params): Promise<ResourceFile> => {
      const p = requireStrings(params, ["cwd", "kind", "scope"]) as unknown as ResourceCreateParams;
      if (!["prompt", "skill", "agents", "extension"].includes(p.kind) || !["user", "project"].includes(p.scope)) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, "kind는 prompt·skill·agents·extension, scope는 user·project여야 합니다");
      }
      const template = p.template && Object.hasOwn(EXTENSION_TEMPLATES, p.template) ? p.template : undefined;
      return createResourceFile(p.kind, p.scope, typeof p.name === "string" ? p.name.trim() : "", p.cwd, agentDirOf(this.env), template).catch(
        asInvalid,
      );
    });

    peer.handle(Methods.fsListDir, (params): Promise<FsListDirResult> => {
      const path = (params as Partial<FsListDirParams> | undefined)?.path;
      return listDirectories(typeof path === "string" ? path : undefined, homedir()).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
    });

    peer.handle(Methods.fsMakeDir, async (params): Promise<{ path: string }> => {
      const p = (params ?? {}) as Partial<FsMakeDirParams>;
      if (typeof p.name !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, "name이 필요합니다");
      const path = await makeDirectory(typeof p.parent === "string" ? p.parent : undefined, p.name, homedir()).catch((e: unknown) => {
        throw new JsonRpcError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
      });
      return { path };
    });

    peer.handle(Methods.daemonStatus, () => this.status());

    peer.handle(Methods.daemonShutdown, () => {
      // 응답을 먼저 보낸 뒤 종료한다.
      setImmediate(() => void this.shutdown("클라이언트 요청"));
      return null;
    });
  }

  /** 이 연결 기준의 입력 권한 */
  private writerState(client: Client, sessionId: string): WriterState {
    const writer = this.writers.get(sessionId);
    return writer === undefined ? "none" : writer === client.id ? "you" : "other";
  }

  /** 입력 권한을 바꾸고, 그 세션에 붙어 있는 연결마다 자기 기준 값을 알린다. */
  private setWriter(sessionId: string, clientId: number | undefined): void {
    if (clientId === undefined) this.writers.delete(sessionId);
    else this.writers.set(sessionId, clientId);
    for (const c of this.clients) {
      if (!c.attached.has(sessionId)) continue;
      const notification: SessionWriterChangedNotification = { sessionId, writer: this.writerState(c, sessionId) };
      c.peer.notify(Notifications.sessionWriterChanged, notification);
    }
  }

  /** 세션을 바꾸는 요청 전에: 권한이 없으면 거부하고, 아무도 없으면 이 연결이 가져간다. */
  private requireWriter(client: Client, sessionId: string): void {
    const writer = this.writers.get(sessionId);
    if (writer === client.id) return;
    if (writer === undefined) return this.setWriter(sessionId, client.id);
    throw new JsonRpcError(ErrorCodes.NotWriter, "다른 앱이 이 세션의 입력 권한을 가지고 있습니다. 제어를 가져온 뒤 입력하세요");
  }

  /** 세션 이벤트를 붙어 있는 클라이언트들에게 전달한다. */
  private wireSession(session: AgentSession): void {
    session.onEntry((entry) => {
      const notification: SessionEventNotification = { sessionId: session.id, ...entry };
      for (const client of this.clients) {
        if (client.attached.has(session.id)) client.peer.notify(Notifications.sessionEvent, notification);
      }
    });
    session.onExternalWrite((path, at) => {
      this.log(`다른 프로그램이 세션 파일에 씀 ${session.id} ${path}`);
      const notification: SessionExternalWriteNotification = { sessionId: session.id, at, path };
      for (const client of this.clients) {
        if (client.attached.has(session.id)) client.peer.notify(Notifications.sessionExternalWrite, notification);
      }
    });
    session.onDialogResolved((id) => {
      const notification: SessionUiResolvedNotification = { sessionId: session.id, id };
      for (const client of this.clients) {
        if (client.attached.has(session.id)) client.peer.notify(Notifications.sessionUiResolved, notification);
      }
    });
    session.onExit((exit) => {
      this.log(`Pi 종료 ${session.id} code=${exit.exitCode} signal=${exit.signal}`);
      const notification: SessionExitNotification = { sessionId: session.id, ...exit };
      for (const client of this.clients) {
        if (client.attached.has(session.id)) client.peer.notify(Notifications.sessionExit, notification);
      }
      this.scheduleIdleCheck();
    });
  }

  private requireSession(sessionId: string | undefined): AgentSession {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) throw new JsonRpcError(ErrorCodes.SessionNotFound, `세션을 찾을 수 없습니다: ${sessionId}`);
    return session;
  }

  private sessionSummaries(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  /**
   * 연결된 앱도, 실행 중인 세션도 없으면 일정 시간 뒤 스스로 종료한다.
   * 종료된(exited) 세션은 "실행 중"으로 치지 않는다.
   */
  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.shuttingDown) return;
    const busy = this.clients.size > 0 || [...this.sessions.values()].some((s) => s.isRunning);
    if (busy) return;
    this.idleTimer = setTimeout(() => void this.shutdown("유휴 시간 초과"), this.idleShutdownMs);
  }

  private log(message: string): void {
    try {
      appendFileSync(join(runDir(this.env), "agentd.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // 로그 실패로 데몬이 죽지 않게 한다.
    }
  }
}

function tryListen(server: Server, path: string): Promise<"ok" | "in-use"> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve("in-use");
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve("ok");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * 세션을 바꾸지 않는 Pi 명령: 읽기 전용 앱도 보낼 수 있다.
 * get_* 조회와, 세션 파일을 읽어 HTML로 내보내는 export_html.
 */
export function isReadOnlyCommand(command: Record<string, unknown>): boolean {
  const type = typeof command.type === "string" ? command.type : "";
  return type.startsWith("get_") || type === "export_html";
}

/** child가 parent 안에 있는지 (경로 문자열 기준, 대소문자는 Windows만 무시) */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const [c, p] = [norm(child), norm(parent)];
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** 문자열 인자들이 있는지 확인하고 그대로 돌려준다 */
function requireStrings(params: unknown, keys: string[]): Record<string, unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof p[key] !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, `${key}가 필요합니다`);
  }
  return p;
}

function requireId(params: unknown): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (!isProviderId(id)) throw new JsonRpcError(ErrorCodes.InvalidParams, "올바른 프로바이더 ID가 필요합니다");
  return id;
}

function requireProvider(params: unknown): string {
  const provider = (params as Partial<AuthProviderParams> | undefined)?.provider;
  if (!isProviderId(provider)) throw new JsonRpcError(ErrorCodes.InvalidParams, "올바른 프로바이더 ID가 필요합니다");
  return provider;
}

/** 파일 작업의 오류를 앱에 보일 수 있는 InvalidParams로 바꾼다 */
function invalidParams(error: unknown): never {
  throw new JsonRpcError(ErrorCodes.InvalidParams, error instanceof Error ? error.message : String(error));
}

function requirePath(params: unknown): StoredPathParams {
  const p = params as StoredPathParams | undefined;
  if (!p?.path) throw new JsonRpcError(ErrorCodes.InvalidParams, "path가 필요합니다");
  return p;
}
