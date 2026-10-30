import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readMcpFile, serverViews, updateMcpFile, withEnabled, withoutServer, withPreset } from "@pi-desktop/pi-isolation/mcp-file";
import { WEB_SEARCH_PRESETS } from "@pi-desktop/pi-isolation/mcp-presets";
import {
  bulkUpdate,
  createEntry,
  exportMarkdown,
  knowledgeStats,
  loadAutoLearn,
  loadEntries,
  markReviewed,
  memoryDir,
  mergeEntries,
  needsReview,
  saveAutoLearn,
  updateEntry,
  type BulkAction,
  type EntryInput,
} from "../extensions/memory/store";
import { buildKnowledgeSection } from "../extensions/memory/recall";
import { deleteSkill, listSkillsIn, saveSkill, type SkillInput } from "../extensions/skills/store";
import { loadAudit, loadRules, removeRule } from "../extensions/permissions/store";
import type { Rule } from "../extensions/permissions/rules";
import { loadElevationEnabled, saveElevationEnabled } from "../extensions/elevation/store";
import { loadTasks, tasksDir } from "../extensions/tasks/store";
import { loadSchedules, schedulesPath, updateSchedules } from "../extensions/schedule/store";
import { approvePeerTask, rejectPeerTask } from "../extensions/peers/tasks";
import { generateCardDraft } from "../extensions/peers/card-draft";
import { DEFAULT_PEER_PORT, type CardDraft, type PeerPolicy, type PeerSettings } from "../extensions/peers/store";
import { normalizeAddress } from "../extensions/peers/protocol";
import { readSessionUsage, readUsageLog, rangeBuckets, summarizeUsage, type UsageRange } from "./usage";
import { searchSessions, type SearchableSession } from "./history-search";
import { approvePairing, checkPairings, forgetPeer, networkState, pairWith, previewPeer, rejectPairing, saveCard, setNetworkSettings, setPeerPolicy } from "./network";

/**
 * 에이전트 앱 화면이 쓰는 agent-kit 데이터 함수 (설계 DESIGN-APPS.md §4 Agent ③, §6 D4).
 *
 * 앱이 이 PC의 파일을 직접 읽던 것을, 대화가 도는 호스트의 Host Agent 데몬이 `agent.call`로 대신 부른다.
 * 그래서 WSL·SSH 호스트를 골라도 그 호스트의 기억·스킬·승인·작업이 보인다. 로컬도 같은 길을 쓴다.
 * 함수는 JSON으로 오가는 값만 받고 돌려준다. 이름이 곧 메서드 이름이다.
 */

export interface AppApiContext {
  /** 그 호스트의 Agent 홈 (데몬 홈, `~/.pi-desktop-agent`) */
  home: string;
  /** agent-kit 상태 폴더 (보통 `<home>/data`) */
  dataDir: string;
  /** 그 호스트의 Pi를 찾는다 (MCP 연결 확인·카드 초안). piCliPath는 개발용 덮어쓰기 */
  locatePi?: (piCliPath?: string) => Promise<{ cliPath: string; nodePath?: string; env?: Record<string, string> }>;
}

/** 로컬 개발 실행에서 앱이 넘기는 덮어쓰기 (저장소의 Pi, 격리된 Pi 설정, mock 프로바이더) */
export interface PiOverrides {
  piCliPath?: string;
  piArgs?: string[];
  env?: Record<string, string>;
}

// 메서드마다 인자 모양이 달라 any로 받는다 (데몬은 이름으로만 찾는다)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppApi = Record<string, (...args: any[]) => Promise<unknown>>;

export function appApi(ctx: AppApiContext): AppApi {
  const kb = () => memoryDir(ctx.dataDir);
  const skills = () => join(ctx.home, "skills");
  const schedules = () => schedulesPath(ctx.dataDir);
  const sessions = () => join(ctx.home, "sessions");
  const mcp = () => join(ctx.home, "mcp.json");
  /** 그 호스트의 Pi를 띄우는 명령 (node + cli.js) */
  const pi = async (overrides: PiOverrides = {}) => {
    if (!ctx.locatePi) throw new Error("Pi를 찾을 수 없는 곳입니다");
    const found = await ctx.locatePi(overrides.piCliPath);
    return {
      command: found.nodePath ?? process.execPath,
      args: [found.cliPath, ...(overrides.piArgs ?? [])],
      env: { ...process.env, ...found.env, ...overrides.env } as NodeJS.ProcessEnv,
    };
  };
  return {
    // 지식베이스
    kbList: (includeArchived?: boolean) => loadEntries(kb(), { includeArchived: includeArchived === true }),
    kbSave: async (id: string | undefined, input: EntryInput) => {
      if (!input?.title?.trim() || !input.content?.trim()) throw new Error("제목과 본문을 적어 주세요");
      if (!id) return createEntry(kb(), { ...input, origin: "user" });
      // 사람이 고친 것은 확인된 것으로 본다
      const entry = await updateEntry(kb(), id, { ...input, unverified: false });
      if (!entry) throw new Error("그 항목을 찾지 못했습니다 (다른 곳에서 지웠을 수 있습니다)");
      return entry;
    },
    kbBulk: (ids: string[], action: BulkAction, tag?: string) => bulkUpdate(kb(), ids, action, tag),
    kbMerge: async (keepId: string, dropIds: string[]) => void (await mergeEntries(kb(), keepId, dropIds)),
    kbReviewed: async (id: string) => void (await markReviewed(kb(), id)),
    kbReview: async () => needsReview(await loadEntries(kb())),
    kbStats: async () => knowledgeStats(await loadEntries(kb(), { includeArchived: true })),
    kbPreview: async (prompt: string) => {
      // 클라우드 모델의 예산(8,000자)으로 보인다. 로컬 모델이면 창에 맞춰 더 줄어든다
      const { text, injected } = buildKnowledgeSection(await loadEntries(kb()), prompt ?? "", 8000);
      return { text: text ?? "", chars: text?.length ?? 0, injected: injected.length };
    },
    /** 내보낼 Markdown 글 (파일은 앱이 이 PC에 저장한다) */
    kbExportText: async () => exportMarkdown(await loadEntries(kb(), { includeArchived: true })),
    getAutoLearn: () => loadAutoLearn(kb()),
    setAutoLearn: async (on: boolean) => void (await saveAutoLearn(kb(), on === true)),

    // 스킬 (앱 홈의 skills/. 지운 것은 상태 폴더의 skills-trash/로)
    skillsList: () => listSkillsIn(skills()),
    skillSave: async (previous: string | undefined, input: SkillInput) => void (await saveSkill(skills(), input, previous)),
    skillDelete: async (name: string) => void (await deleteSkill(skills(), name, join(ctx.dataDir, "skills-trash"))),
    skillsDir: async () => skills(),

    // 승인 규칙·판단 기록, 관리자 권한
    listRules: () => loadRules(ctx.dataDir),
    removeRule: async (rule: Rule) => void (await removeRule(ctx.dataDir, rule)),
    listAudit: () => loadAudit(ctx.dataDir, 100),
    getElevation: () => loadElevationEnabled(ctx.dataDir),
    setElevation: async (on: boolean) => void (await saveElevationEnabled(ctx.dataDir, on === true)),

    // 작업·예약
    listTasks: async (limit?: number) => (await loadTasks(tasksDir(ctx.dataDir))).slice(0, limit ?? 30),
    listSchedules: () => loadSchedules(schedules()),
    setScheduleEnabled: async (id: string, enabled: boolean) =>
      void (await updateSchedules(schedules(), (all) => all.map((s) => (s.id === id ? { ...s, enabled: enabled === true } : s)))),
    removeSchedule: async (id: string) => void (await updateSchedules(schedules(), (all) => all.filter((s) => s.id !== id))),

    // 사용량: 이 호스트의 Agent 대화(세션 파일)와 세션에 남지 않는 쓰임(기억 추출·문서·워커)
    usageSummary: async (range: UsageRange) => {
      const now = new Date();
      const { from } = rangeBuckets(range, now);
      const [inSessions, offSession] = await Promise.all([readSessionUsage(sessions(), from), readUsageLog(ctx.dataDir, from)]);
      return summarizeUsage([...inSessions, ...offSession], range, now);
    },

    // 지난 대화 본문 검색. 세션 폴더 안의 파일만 읽는다
    searchHistory: async (items: SearchableSession[], query: string) => {
      const root = resolve(sessions());
      const inside = (items ?? []).filter((item) => {
        const rel = relative(root, resolve(item.path));
        return rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
      });
      return searchSessions(inside, query, (path) => readFile(path, "utf8"));
    },

    // MCP (앱 홈의 mcp.json, pi-isolation과 같은 코드)
    mcpList: async () => serverViews(await readMcpFile(mcp())),
    mcpAddPreset: (id: string, key?: string) => {
      const preset = WEB_SEARCH_PRESETS.find((p) => p.id === id);
      if (!preset) throw new Error(`모르는 서버입니다: ${id}`);
      return updateMcpFile(mcp(), (file) => withPreset(file, preset, key));
    },
    mcpSetEnabled: (name: string, enabled: boolean) => updateMcpFile(mcp(), (file) => withEnabled(file, name, enabled === true)),
    mcpRemove: (name: string) => updateMcpFile(mcp(), (file) => withoutServer(file, name)),
    /** 없으면 빈 설정을 만들고 경로를 돌려준다 (로컬이면 앱이 연다) */
    mcpEnsureFile: async () => {
      await updateMcpFile(mcp(), (file) => ({ mcpServers: {}, ...file }));
      return mcp();
    },
    /**
     * pi mcp list: 켜진 서버마다 연결해 상태·도구·오류를 찍고, 연결 안 된 것이 있으면 1로 끝난다.
     * pi mcp는 Pi 설정 폴더의 mcp.json만 읽으므로 이 실행에서만 설정 폴더를 앱 홈으로 바꾼다.
     * 그래서 OAuth 로그인이 필요한 서버는 로그인 안 됨으로 보일 수 있다 (세션은 Pi의 mcp-auth.json을 쓴다, pi-isolation 참고)
     */
    mcpCheck: async (overrides?: PiOverrides) => {
      const run = await pi(overrides);
      return new Promise<{ ok: boolean; output: string }>((done) => {
        execFile(
          run.command,
          [...run.args, "mcp", "list"],
          { cwd: ctx.home, env: { ...run.env, PI_CODING_AGENT_DIR: ctx.home }, timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => done({ ok: !error, output: `${stdout}${stderr ? `\n${stderr}` : ""}` }),
        );
      });
    },

    // 내 카드 초안: 그 호스트의 Pi를 한 번(--print, 도구·확장 없음) 불러 만든다. 재료는 사실·교훈 기억과 대화 이름뿐
    suggestCard: async (current: CardDraft, sessionNames: string[], overrides?: PiOverrides) => {
      const memories = (await loadEntries(kb())).map((m) => ({ type: m.type, title: m.title, tags: m.tags }));
      const cwd = await mkdtemp(join(tmpdir(), "agent-card-"));
      return generateCardDraft(await pi(overrides), { memories, sessionNames: (sessionNames ?? []).slice(0, 50), current }, cwd);
    },

    // 네트워크(피어). 수신 서버는 그 호스트의 스케줄러 세션이 띄우므로 상태도 그 호스트에서 본다
    networkState: () => networkState(ctx.dataDir),
    setNetworkSettings: (settings: PeerSettings) => setNetworkSettings(ctx.dataDir, settings),
    saveCard: (card: CardDraft) => saveCard(ctx.dataDir, card),
    previewPeer: (address: string) => previewPeer(normalizeAddress(address, DEFAULT_PEER_PORT)),
    pairWith: async (address: string) => void (await pairWith(ctx.dataDir, normalizeAddress(address, DEFAULT_PEER_PORT))),
    checkPairings: () => checkPairings(ctx.dataDir),
    approvePairing: (requestId: string) => approvePairing(ctx.dataDir, requestId),
    rejectPairing: async (requestId: string) => void (await rejectPairing(ctx.dataDir, requestId)),
    forgetPeer: async (id: string) => void (await forgetPeer(ctx.dataDir, id)),
    setPeerPolicy: async (id: string, policy: PeerPolicy) => void (await setPeerPolicy(ctx.dataDir, id, policy)),
    approvePeerTask: (id: string, cwd: string) => approvePeerTask(ctx.dataDir, id, cwd),
    rejectPeerTask: (id: string) => rejectPeerTask(ctx.dataDir, id),
  };
}
