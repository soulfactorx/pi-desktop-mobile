import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { appendChat, readChat, readInbox } from "@pi-desktop/mate-kit";
import { resourceHome } from "@pi-desktop/pi-resources";
import { rangeBuckets, readSessionUsage, summarizeUsage, type UsageRange } from "@pi-desktop/agent-kit/usage";
import { listDirectories, makeDirectory } from "../../host-agent/src/dir-list";
import { addChatRequest, loadChatState } from "./chat/chat-agent";
import { removeChatImages, saveChatImages } from "./chat/chat-images";
import { delegateInboxItem } from "./delegate";
import type { PiLaunch } from "./executor";
import { applyInboxChange, discardInboxChange } from "./inbox-change";
import { applyInstall, describeInstall } from "./install";
import { OBSERVER_DUTY_ID, OBSERVER_NAME, readActivity, topicFeedback } from "./observer";
import type { MatePaths } from "./paths";
import { piReadiness } from "./pi-readiness";
import { loadRemoteState } from "./remote/telegram-remote";
import { nextRunAt } from "./schedule";
import { parseTranscript } from "./session-transcript";
import {
  addRequest,
  clearChat,
  deleteDuty,
  deleteRun,
  deleteSkill,
  dutyIdFrom,
  findSessionFile,
  getDuty,
  isDutyId,
  listDuties,
  listRuns,
  loadConfig,
  loadInboxState,
  loadState,
  pendingRequests,
  saveConfig,
  saveDuty,
  setInboxStatus,
  type ConfigPatch,
} from "./store";
import { emptyTrash, listTrash, restoreTrash } from "./trash";
import type { InboxStatus } from "./types";
import type { DutyDraft, Overview, RunnerView } from "./view-types";

/**
 * Mate 앱 화면이 쓰는 실행기 함수 (설계 DESIGN-MATE-REMOTE.md §2.2). 실행기가 `mate.call { name, args }`로 부른다.
 * 앱이 Mate 홈 파일을 직접 읽던 것을 실행기가 대신 한다. 로컬도 원격도 같은 길이다.
 * 함수는 JSON으로 오가는 값만 받고 돌려준다. 이름이 곧 메서드 이름이다.
 */

export interface MateAppContext {
  paths: MatePaths;
  /** 실행기 상태 (overview의 runner) */
  runnerView: () => Promise<RunnerView>;
  /** 할 일이 생겼으니 실행기를 깨운다 ("지금 실행"·맡기기) */
  wake: () => void;
  /** 그 호스트의 Pi (MCP 연결 확인) */
  locatePi: () => Promise<PiLaunch>;
  /** 실행기를 멈춘다 (답을 보낸 뒤). 원격 실행기를 앱에서 멈추거나 다시 띄울 때 쓴다 */
  shutdown?: () => void;
  /** 휴대폰 연결 토큰을 메모리에 두고 연결을 켠다 (빈 값이면 끈다). 원격 호스트의 휴대폰 연결 (DESIGN-MATE-REMOTE.md §5) */
  setTelegramToken?: (token: string | undefined) => void;
}

// 메서드마다 인자 모양이 달라 any로 받는다 (실행기는 이름으로만 찾는다)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MateAppApi = Record<string, (...args: any[]) => Promise<unknown>>;

export function mateAppApi(ctx: MateAppContext): MateAppApi {
  const { paths } = ctx;
  const resources = resourceHome({
    home: paths.home,
    deleteSkill: (name) => deleteSkill(paths, name),
    pi: async () => {
      const pi = await ctx.locatePi();
      return { command: pi.nodePath ?? process.execPath, args: [pi.cliPath], env: { ...process.env, ...pi.env } };
    },
  });

  async function overview(): Promise<Overview> {
    const [config, duties, state, requests, items, inboxState, runs, runner, trash] = await Promise.all([
      loadConfig(paths),
      listDuties(paths),
      loadState(paths),
      pendingRequests(paths),
      readInbox(paths.inbox),
      loadInboxState(paths),
      listRuns(paths, 100),
      ctx.runnerView(),
      listTrash(paths),
    ]);
    const [activity, feedback, chatLines, chatState] = await Promise.all([readActivity(paths, 150), topicFeedback(paths), readChat(paths.chat), loadChatState(paths)]);
    const now = Date.now();
    const names = new Map<string, string>([[OBSERVER_DUTY_ID, OBSERVER_NAME], ...duties.map((d) => [d.id, d.name] as [string, string])]);
    const queued = new Set(requests.map((r) => r.dutyId));
    return {
      home: paths.home,
      chat: {
        lines: chatLines.slice(-300),
        ...(chatState.busy ? { busy: chatState.busy } : {}),
        pending: Object.keys(chatState.pending).length,
      },
      config,
      duties: duties.map((duty) => {
        const last = state.duties[duty.id];
        const next = nextRunAt(duty, last?.lastRunAt, now, last?.watch);
        const pending = last?.watch?.pending;
        return {
          ...duty,
          ...(last?.lastRunAt ? { lastRunAt: last.lastRunAt } : {}),
          ...(last?.lastStatus ? { lastStatus: last.lastStatus } : {}),
          ...(next !== undefined ? { nextRunAt: next } : {}),
          ...(pending ? { pendingChange: { cause: pending.cause, since: pending.since } } : {}),
          queued: queued.has(duty.id),
        };
      }),
      inbox: items
        .map((item) => ({ ...item, ...(inboxState[item.id] ? { status: inboxState[item.id]!.status } : {}), dutyName: names.get(item.dutyId) ?? item.dutyId }))
        .sort((a, b) => b.createdAt - a.createdAt),
      runs,
      runner,
      observe: {
        activity: activity.reverse(),
        queue: state.observer?.queue.length ?? 0,
        today: state.observer?.today ?? { date: "", count: 0 },
        projects: Object.values(state.observer?.projects ?? {}),
        feedback,
        ...(state.observer ? { since: state.observer.since } : {}),
      },
      trash,
    };
  }

  return {
    overview,
    config: () => loadConfig(paths),
    saveConfig: (patch: ConfigPatch) => saveConfig(paths, patch),

    // 임무
    saveDuty: async (draft: DutyDraft) => {
      const now = Date.now();
      if (draft.id) {
        const existing = await getDuty(paths, draft.id);
        if (!existing) throw new Error("임무를 찾지 못했습니다");
        return saveDuty(paths, { ...existing, ...draft, id: existing.id, createdAt: existing.createdAt, updatedAt: now });
      }
      const id = dutyIdFrom(draft.name, (await listDuties(paths)).map((d) => d.id));
      return saveDuty(paths, { ...draft, id, createdAt: now });
    },
    deleteDuty: async (id: string) => void (await deleteDuty(paths, id)),
    runNow: async (id: string) => {
      if (!isDutyId(id)) throw new Error("잘못된 임무 id입니다");
      await addRequest(paths, id);
      ctx.wake();
    },

    // 인박스
    setInbox: async (ids: string[], status: InboxStatus | undefined) => void (await setInboxStatus(paths, (ids ?? []).filter((id) => typeof id === "string"), status)),
    applyChange: async (itemId: string) => void (await applyInboxChange(paths, String(itemId))),
    discardChange: async (itemId: string) => void (await discardInboxChange(paths, String(itemId))),
    /** "Mate에게 맡기기": 제안의 맡길 일을 그 폴더에서 바로 실행한다 (DESIGN-MATE.md §10) */
    delegate: async (itemId: string) => {
      await delegateInboxItem(paths, String(itemId));
      ctx.wake();
    },
    applyInstall: (itemId: string) => applyInstall(paths, itemId, process.env, (source) => resources.packageInstall(source)),
    describeInstall: async (itemId: string) => {
      const item = (await readInbox(paths.inbox)).find((i) => i.id === itemId);
      if (!item?.install) throw new Error("설치 제안을 찾지 못했습니다");
      return describeInstall(item.install);
    },

    // 실행 기록·휴지통
    deleteRun: async (id: string) => void (await deleteRun(paths, id)),
    readSession: async (runId: string) => {
      const run = (await listRuns(paths, 1000)).find((r) => r.id === runId);
      // 실행 기록에 적힌 경로라도 Mate 홈의 sessions/ 밖은 읽지 않는다
      const file = run?.sessionId ? await findSessionFile(paths, run.sessionId) : undefined;
      if (!file) throw new Error("이 실행의 세션 파일을 찾지 못했습니다");
      return parseTranscript(await readFile(file, "utf8"));
    },
    clearChat: () => clearChat(paths),
    restoreTrash: async (id: string) => void (await restoreTrash(paths, id)),
    emptyTrash: (ids?: string[]) => emptyTrash(paths, ids),

    // 대화: 사용자의 말을 기록에 남기고 대화 담당에 넘긴다 (답은 대화 담당이 남긴다)
    // images: 붙여넣거나 고른 이미지 (Pi에 함께 넘긴다. 이미지를 볼 수 없는 모델이면 Pi가 알린다)
    chatSend: async (text: string, answerTo?: string, images?: unknown) => {
      const files = await saveChatImages(paths, images);
      const t = (String(text ?? "").trim() || (files.length > 0 ? "첨부한 이미지를 봐 주세요." : "")).slice(0, 4000);
      if (!t) return;
      const answer = typeof answerTo === "string" ? answerTo : undefined;
      try {
        const line = await appendChat(paths.chat, { role: "user", text: t, source: "app", ...(answer ? { answerTo: answer } : {}), ...(files.length ? { images: files.length } : {}) });
        await addChatRequest(paths, { text: t, source: "app", lineId: line.id, ...(answer ? { answerTo: answer } : {}), ...(files.length ? { images: files } : {}) });
      } catch (error) {
        await removeChatImages(files);
        throw error;
      }
    },

    // 사용량: Mate 대화와 임무 실행의 Pi 세션 (Agent 사용량 화면과 같은 집계)
    usageSummary: async (range: UsageRange) => {
      const now = new Date();
      const { from } = rangeBuckets(range, now);
      const [chat, runs] = await Promise.all([readSessionUsage(paths.chatSessions, from, "chat"), readSessionUsage(paths.sessions, from, "schedule")]);
      return summarizeUsage([...chat, ...runs], range, now);
    },

    // 스킬·MCP (Mate 홈의 skills/·mcp.json, 지운 스킬은 Mate 휴지통으로). 관리 코드는 세 앱이 함께 쓴다 (pi-resources)
    skillsList: resources.skillsList,
    skillSave: resources.skillSave,
    skillDelete: resources.skillDelete,
    mcpList: resources.mcpList,
    mcpAddPreset: resources.mcpAddPreset,
    mcpSetEnabled: resources.mcpSetEnabled,
    mcpRemove: resources.mcpRemove,
    mcpEnsureFile: resources.mcpEnsureFile,
    mcpReadText: resources.mcpReadText,
    mcpWriteText: resources.mcpWriteText,
    mcpCheck: () => resources.mcpCheck(),
    // Pi 패키지(확장)와 다른 앱에서 가져오기 (DESIGN-APPS.md §3.5)
    packagesList: resources.packagesList,
    packageInstall: (source: string) => resources.packageInstall(source),
    packageRemove: (source: string) => resources.packageRemove(source),
    importList: resources.importList,
    importSkill: resources.importSkill,

    // Pi 준비 상태 (그 호스트의 Pi)
    piReadiness: () => piReadiness(),

    // 휴대폰 연결 상태 (실행기가 쓰는 remote.json)
    remoteState: () => loadRemoteState(paths),

    /** 휴대폰 연결 토큰을 넘긴다 (null이면 끈다). 실행기는 메모리에만 두고 결과에 토큰을 담지 않는다 */
    setTelegramToken: async (token: unknown) => {
      if (!ctx.setTelegramToken) throw new Error("이 실행기는 휴대폰 연결 토큰을 받을 수 없습니다");
      if (token !== null && token !== undefined && typeof token !== "string") throw new Error("토큰은 글자여야 합니다");
      ctx.setTelegramToken(token ?? undefined);
    },
    /** 실행기를 멈춘다. 답을 보낸 뒤 끝나도록 조금 늦춘다 (원격 호스트를 바꾸거나 다시 띄울 때, DESIGN-MATE-REMOTE.md §3.1) */
    stopRunner: async () => {
      if (!ctx.shutdown) throw new Error("이 실행기는 멈출 수 없습니다");
      setTimeout(ctx.shutdown, 100);
    },

    // 그 호스트의 폴더 훑기 (임무 폴더 고르기)
    listDir: (path?: string) => listDirectories(path, homedir()),
    makeDir: (parent: string, name: string) => makeDirectory(parent, name, homedir()),
  };
}
