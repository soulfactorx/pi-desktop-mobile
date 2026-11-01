import { IpcChannels, type PiDesktopApi } from "./api";

/**
 * 화면(renderer)이 쓰는 `window.piDesktop`을 만든다.
 *
 * 채널 이름과 인자 순서는 Electron IPC와 웹 서버(WebSocket)가 같다. 그래서 API 모양은 여기 한 곳에 두고,
 * 실제로 보내는 방법(transport)만 바꿔 끼운다: Electron은 preload의 ipcRenderer, 웹은 web/ws-transport.ts.
 */
export interface ApiTransport {
  /** 요청을 보내고 응답을 기다린다 (ipcRenderer.invoke와 같음) */
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  /** 응답 없이 보낸다 (ipcRenderer.send와 같음) */
  send(channel: string, ...args: unknown[]): void;
  /** 알림을 구독하고 해제 함수를 돌려준다. 알림의 인자를 그대로 넘긴다 */
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
}

/** main이 보내는 (hostId, payload) 알림을 구독하고, 해제 함수를 돌려준다. */
function subscribe<T>(t: ApiTransport, channel: string, listener: (hostId: string, payload: T) => void): () => void {
  return t.on(channel, (hostId, payload) => listener(hostId as string, payload as T));
}

export function createPiDesktopApi(t: ApiTransport, shell: PiDesktopApi["shell"]): PiDesktopApi {
  return {
    shell,
    listHosts: () => t.invoke(IpcChannels.listHosts),
    connectHost: (hostId) => t.invoke(IpcChannels.connectHost, hostId),
    reconnectHost: (hostId) => t.invoke(IpcChannels.reconnectHost, hostId),
    listSshHosts: () => t.invoke(IpcChannels.listSshHosts),
    saveSshHost: (host, previousName) => t.invoke(IpcChannels.saveSshHost, host, previousName),
    removeSshHost: (name) => t.invoke(IpcChannels.removeSshHost, name),
    replaceAgent: (hostId) => t.invoke(IpcChannels.replaceAgent, hostId),
    locatePi: (hostId) => t.invoke(IpcChannels.locatePi, hostId),
    listSessions: (hostId) => t.invoke(IpcChannels.listSessions, hostId),
    listHistory: (hostId, cwd) => t.invoke(IpcChannels.listHistory, hostId, cwd),
    inspectStored: (hostId, path) => t.invoke(IpcChannels.inspectStored, hostId, path),
    deleteStored: (hostId, path) => t.invoke(IpcChannels.deleteStored, hostId, path),
    listTrash: (hostId) => t.invoke(IpcChannels.listTrash, hostId),
    restoreTrash: (hostId, id) => t.invoke(IpcChannels.restoreTrash, hostId, id),
    emptyTrash: (hostId, ids) => t.invoke(IpcChannels.emptyTrash, hostId, ids),
    setArchived: (hostId, path, archived) => t.invoke(IpcChannels.setArchived, hostId, path, archived),
    readStored: (hostId, path) => t.invoke(IpcChannels.readStored, hostId, path),
    watchStored: (hostId, path) => t.invoke(IpcChannels.watchStored, hostId, path),
    unwatchStored: (hostId, path) => t.invoke(IpcChannels.unwatchStored, hostId, path),
    watchTree: (hostId, watchId, roots) => t.invoke(IpcChannels.watchTree, hostId, watchId, roots),
    playgroundRun: (hostId, params) => t.invoke(IpcChannels.playgroundRun, hostId, params),
    usageSummary: (hostId, range) => t.invoke(IpcChannels.usageSummary, hostId, range),
    playgroundStop: (hostId, runId) => t.invoke(IpcChannels.playgroundStop, hostId, runId),
    unwatchTree: (hostId, watchId) => t.invoke(IpcChannels.unwatchTree, hostId, watchId),
    openSession: (hostId, request) => t.invoke(IpcChannels.openSession, hostId, request),
    attachSession: (hostId, sessionId, lastSeq) =>
      t.invoke(IpcChannels.attachSession, hostId, sessionId, lastSeq),
    closeSession: (hostId, sessionId) => t.invoke(IpcChannels.closeSession, hostId, sessionId),
    clearExternalWrite: (hostId, sessionId) => t.invoke(IpcChannels.clearExternalWrite, hostId, sessionId),
    claimWriter: (hostId, sessionId) => t.invoke(IpcChannels.claimWriter, hostId, sessionId),
    sendCommand: (hostId, sessionId, command) =>
      t.invoke(IpcChannels.sendCommand, hostId, sessionId, command),
    sendRecord: (hostId, sessionId, record) => t.invoke(IpcChannels.sendRecord, hostId, sessionId, record),
    pickDirectory: () => t.invoke(IpcChannels.pickDirectory),
    revealFile: (hostId, cwd, path) => t.invoke(IpcChannels.revealFile, hostId, cwd, path),
    piStatus: (hostId) => t.invoke(IpcChannels.piStatus, hostId),
    piUpdate: (hostId, target, taskId, force) =>
      t.invoke(IpcChannels.piUpdate, hostId, target, taskId, force === true),
    authProviders: (hostId) => t.invoke(IpcChannels.authProviders, hostId),
    authCheck: (hostId, provider) => t.invoke(IpcChannels.authCheck, hostId, provider),
    authSetApiKey: (hostId, provider, key) => t.invoke(IpcChannels.authSetApiKey, hostId, provider, key),
    authRemove: (hostId, provider) => t.invoke(IpcChannels.authRemove, hostId, provider),
    modelsRead: (hostId) => t.invoke(IpcChannels.modelsRead, hostId),
    modelsSaveProvider: (hostId, provider, previousId) =>
      t.invoke(IpcChannels.modelsSaveProvider, hostId, provider, previousId),
    modelsRemoveProvider: (hostId, id) => t.invoke(IpcChannels.modelsRemoveProvider, hostId, id),
    modelsProbe: (hostId, baseUrl, apiKey, providerId) =>
      t.invoke(IpcChannels.modelsProbe, hostId, baseUrl, apiKey, providerId),
    terminalOpen: (request) => t.invoke(IpcChannels.terminalOpen, request),
    terminalWrite: (id, data) => t.send(IpcChannels.terminalWrite, id, data),
    terminalResize: (id, cols, rows) => t.send(IpcChannels.terminalResize, id, cols, rows),
    terminalClose: (id) => t.send(IpcChannels.terminalClose, id),
    onTerminalData: (listener) => subscribe(t, IpcChannels.terminalData, listener),
    onTerminalExit: (listener) => subscribe(t, IpcChannels.terminalExit, listener),
    dataBackup: (hostId) => t.invoke(IpcChannels.dataBackup, hostId),
    dataDelete: (hostId, confirm) => t.invoke(IpcChannels.dataDelete, hostId, confirm),
    piVersions: (hostId) => t.invoke(IpcChannels.piVersions, hostId),
    piLatest: (hostId, force) => t.invoke(IpcChannels.piLatest, hostId, force === true),
    piModels: (hostId) => t.invoke(IpcChannels.piModels, hostId),
    searchFiles: (hostId, cwd, query) => t.invoke(IpcChannels.searchFiles, hostId, cwd, query),
    listDir: (hostId, path) => t.invoke(IpcChannels.listDir, hostId, path),
    makeDir: (hostId, parent, name) => t.invoke(IpcChannels.makeDir, hostId, parent, name),
    listResources: (hostId, cwd) => t.invoke(IpcChannels.listResources, hostId, cwd),
    marketSearch: (query, from) => t.invoke(IpcChannels.marketSearch, query, from),
    marketDetail: (name) => t.invoke(IpcChannels.marketDetail, name),
    githubBrowse: (spec) => t.invoke(IpcChannels.githubBrowse, spec),
    githubText: (repo, path) => t.invoke(IpcChannels.githubText, repo, path),
    githubImport: (request) => t.invoke(IpcChannels.githubImport, request),
    listImports: (hostId) => t.invoke(IpcChannels.listImports, hostId),
    exportResource: (hostId, kind, path) => t.invoke(IpcChannels.exportResource, hostId, kind, path),
    modelsExport: (hostId, id) => t.invoke(IpcChannels.modelsExport, hostId, id),
    modelsImport: (hostId, id, provider, replace) => t.invoke(IpcChannels.modelsImport, hostId, id, provider, replace),
    modelsExportModel: (hostId, providerId, modelId) => t.invoke(IpcChannels.modelsExportModel, hostId, providerId, modelId),
    modelsImportModel: (hostId, providerId, model, replace) =>
      t.invoke(IpcChannels.modelsImportModel, hostId, providerId, model, replace),
    settingsRead: (hostId, target) => t.invoke(IpcChannels.settingsRead, hostId, target),
    settingsWrite: (hostId, content, baseMtime, target) => t.invoke(IpcChannels.settingsWrite, hostId, content, baseMtime, target),
    packageResources: (hostId, cwd, source, scope, overlay) => t.invoke(IpcChannels.packageResources, hostId, cwd, source, scope, overlay),
    setPackageFilter: (hostId, cwd, source, scope, changes, reset, set, overlay) =>
      t.invoke(IpcChannels.setPackageFilter, hostId, cwd, source, scope, changes, reset, set, overlay),
    settingsMerge: (hostId, values, remove, target) => t.invoke(IpcChannels.settingsMerge, hostId, values, remove, target),
    settingsSchema: (hostId) => t.invoke(IpcChannels.settingsSchema, hostId),
    importResourceFiles: (hostId, params) => t.invoke(IpcChannels.importResourceFiles, hostId, params),
    importStatus: (hostId) => t.invoke(IpcChannels.importStatus, hostId),
    recordCopy: (input) => t.invoke(IpcChannels.recordCopy, input),
    copyStatus: (hostId) => t.invoke(IpcChannels.copyStatus, hostId),
    hostInventory: (hostId) => t.invoke(IpcChannels.hostInventory, hostId),
    listActionLog: (limit) => t.invoke(IpcChannels.listActionLog, limit),
    updateState: () => t.invoke(IpcChannels.updateState),
    checkForUpdates: (interactive) => t.invoke(IpcChannels.checkForUpdates, interactive === true),
    confirmUpdate: () => t.invoke(IpcChannels.confirmUpdate),
    installUpdate: () => t.invoke(IpcChannels.installUpdate),
    openRelease: () => t.invoke(IpcChannels.openRelease),
    onMenuCommand: (listener) => t.on(IpcChannels.menuCommand, (id) => listener(id as string)),
    onUpdateState: (listener) => t.on(IpcChannels.updateStateChanged, (state) => listener(state as Parameters<typeof listener>[0])),
    logAction: (entry) => t.invoke(IpcChannels.logAction, entry),
    importUpdate: (hostId, target) => t.invoke(IpcChannels.importUpdate, hostId, target),
    importRemove: (hostId, target) => t.invoke(IpcChannels.importRemove, hostId, target),
    importDiff: (hostId, target, path, upstreamSha) => t.invoke(IpcChannels.importDiff, hostId, target, path, upstreamSha),
    getTrust: (hostId, cwd) => t.invoke(IpcChannels.getTrust, hostId, cwd),
    setTrust: (hostId, cwd, decision) => t.invoke(IpcChannels.setTrust, hostId, cwd, decision),
    readResource: (hostId, cwd, path) => t.invoke(IpcChannels.readResource, hostId, cwd, path),
    writeResource: (hostId, cwd, path, content, baseMtime) =>
      t.invoke(IpcChannels.writeResource, hostId, cwd, path, content, baseMtime),
    createResource: (hostId, cwd, kind, scope, name, template) => t.invoke(IpcChannels.createResource, hostId, cwd, kind, scope, name, template),
    createPackage: (hostId, params) => t.invoke(IpcChannels.createPackage, hostId, params),
    listMyPackages: (hostId) => t.invoke(IpcChannels.listMyPackages, hostId),
    deleteMyPackage: (hostId, folder) => t.invoke(IpcChannels.deleteMyPackage, hostId, folder),
    deleteResource: (hostId, path, kind) => t.invoke(IpcChannels.deleteResource, hostId, path, kind),
    onConnection: (listener) => subscribe(t, IpcChannels.connectionChanged, listener),
    onSessionEvent: (listener) => subscribe(t, IpcChannels.sessionEvent, listener),
    onSessionExit: (listener) => subscribe(t, IpcChannels.sessionExit, listener),
    onUiResolved: (listener) => subscribe(t, IpcChannels.uiResolved, listener),
    onStoredChanged: (listener) => subscribe(t, IpcChannels.storedChanged, listener),
    onExternalWrite: (listener) => subscribe(t, IpcChannels.externalWrite, listener),
    onWriterChanged: (listener) => subscribe(t, IpcChannels.writerChanged, listener),
    onFilesChanged: (listener) => subscribe(t, IpcChannels.filesChanged, listener),
    onPlaygroundOutput: (listener) => subscribe(t, IpcChannels.playgroundOutput, listener),
    onPiUpdateOutput: (listener) => subscribe(t, IpcChannels.piUpdateOutput, listener),
  };
}
