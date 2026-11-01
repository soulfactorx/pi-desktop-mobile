import { useEffect, useState } from "react";
import type { SkillInput, SkillView } from "@pi-desktop/agent-kit/skill-types";
import { WEB_SEARCH_PRESETS, type McpCheckResult, type McpPreset, type McpServerView } from "@pi-desktop/pi-isolation/mcp-presets";

/**
 * 스킬·MCP 관리 화면의 상태와 동작 (DESIGN-APPS.md §3.5). 세 앱이 같은 동작을 쓰고, 모양(마크업·CSS)만 앱마다 그린다.
 * 앱은 자기 API(window.piAgent·window.mate 등)를 아래 모양으로 넘기고, 오류 처리는 run으로 넘긴다.
 */

/** 작업을 실행하고 오류를 앱 방식으로 보여 준다 */
export type Run = (job: () => Promise<void>) => void;

export interface SkillApi {
  list(): Promise<SkillView[]>;
  save(previous: string | undefined, input: SkillInput): Promise<void>;
  remove(name: string): Promise<void>;
}

/** 편집 중인 스킬. previous가 없으면 새 스킬 */
export interface SkillDraft extends SkillInput {
  previous?: string;
}

export const emptySkillDraft = (): SkillDraft => ({ name: "", description: "", instructions: "", modelInvocation: true });
export const skillDraftOf = (s: SkillView): SkillDraft => ({
  previous: s.name,
  name: s.name,
  description: s.description,
  instructions: s.instructions,
  modelInvocation: s.modelInvocation,
});
export const skillDraftReady = (d: SkillDraft): boolean => Boolean(d.name.trim() && d.description.trim() && d.instructions.trim());

export function useSkills(api: SkillApi, run: Run) {
  const [skills, setSkills] = useState<SkillView[]>();
  const [draft, setDraft] = useState<SkillDraft>();
  const refresh = async () => setSkills(await api.list());
  useEffect(() => run(refresh), []);
  return {
    skills,
    draft,
    setDraft,
    refresh: () => run(refresh),
    /** 고치는 중인 스킬을 저장하고 목록을 다시 읽는다. 저장되면 onSaved를 부른다 */
    save: (onSaved?: () => void) =>
      run(async () => {
        if (!draft) return;
        const { previous, ...input } = draft;
        await api.save(previous, input);
        await refresh();
        setDraft(undefined);
        onSaved?.();
      }),
    /** 묻고 지운다 (지운 스킬은 휴지통으로 간다) */
    remove: (name: string, question: string, onRemoved?: () => void) =>
      run(async () => {
        if (!confirm(question)) return;
        await api.remove(name);
        onRemoved?.();
        await refresh();
      }),
  };
}

export interface McpApi {
  list(): Promise<McpServerView[]>;
  addPreset(id: string, key?: string): Promise<McpServerView[]>;
  setEnabled(name: string, enabled: boolean): Promise<McpServerView[]>;
  remove(name: string): Promise<McpServerView[]>;
  check(): Promise<McpCheckResult>;
}

/** 미리 설정해 둔 서버 한 줄 */
export interface McpPresetRow {
  preset: McpPreset;
  server?: McpServerView;
  added: boolean;
  /** 키가 필요한데 아직 없다 (제안으로 키 없이 꺼진 채 넣은 서버 포함) */
  needsKey: boolean;
}

export function useMcp(api: McpApi, run: Run) {
  const [servers, setServers] = useState<McpServerView[]>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<McpCheckResult>();
  const [checking, setChecking] = useState(false);
  const [changed, setChanged] = useState(false);
  useEffect(() => run(async () => setServers(await api.list())), []);

  const apply = (job: () => Promise<McpServerView[]>) =>
    run(async () => {
      setServers(await job());
      setChanged(true);
      setCheck(undefined);
    });
  const presets: McpPresetRow[] = WEB_SEARCH_PRESETS.map((preset) => {
    const server = servers?.find((s) => s.name === preset.name);
    return { preset, ...(server ? { server } : {}), added: Boolean(server), needsKey: Boolean(preset.keyEnv) && (!server || !server.hasSecrets) };
  });
  return {
    servers,
    presets,
    keys,
    setKey: (id: string, value: string) => setKeys((prev) => ({ ...prev, [id]: value })),
    /** 키가 필요한 서버는 키를 넣어야 넣을 수 있다 */
    canAdd: (row: McpPresetRow) => !row.preset.keyEnv || Boolean(keys[row.preset.id]?.trim()),
    addPreset: (id: string) => {
      const key = keys[id];
      apply(() => api.addPreset(id, key));
      setKeys((prev) => ({ ...prev, [id]: "" }));
    },
    setEnabled: (name: string, enabled: boolean) => apply(() => api.setEnabled(name, enabled)),
    remove: (name: string) => apply(() => api.remove(name)),
    /** 이 화면에서 설정을 바꿨는지 (열린 대화는 다시 열어야 적용됨을 알릴 때) */
    changed,
    check,
    checking,
    runCheck: () =>
      run(async () => {
        setChecking(true);
        try {
          setCheck(await api.check());
        } finally {
          setChecking(false);
        }
      }),
  };
}
