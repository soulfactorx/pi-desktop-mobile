import { useEffect, useState } from "react";
import type { SkillInput, SkillView } from "@pi-desktop/agent-kit/skill-types";
import { WEB_SEARCH_PRESETS, type McpCheckResult, type McpPreset, type McpServerView } from "@pi-desktop/pi-isolation/mcp-presets";
import type { AppId, Importables, PackageResult, PackageView } from "./types";

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
  /** mcp.json 원문 읽기·저장 (앱 안 편집기). 없으면 편집기를 보이지 않는다 */
  readText?(): Promise<{ path: string; text: string }>;
  writeText?(text: string): Promise<McpServerView[]>;
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
  /** 앱 안에서 고치는 mcp.json 원문 (열려 있을 때만) */
  const [editor, setEditor] = useState<{ path: string; text: string }>();
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
    editor,
    canEdit: Boolean(api.readText && api.writeText),
    openEditor: () => run(async () => setEditor(await api.readText!())),
    setEditorText: (text: string) => setEditor((prev) => (prev ? { ...prev, text } : prev)),
    closeEditor: () => setEditor(undefined),
    /** 저장하면 편집기를 닫는다. JSON이 틀리면 run이 오류를 보이고 편집기는 남는다 */
    saveEditor: () => {
      const text = editor?.text;
      if (text === undefined) return;
      apply(async () => {
        const next = await api.writeText!(text);
        setEditor(undefined);
        return next;
      });
    },
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

export interface PackageApi {
  list(): Promise<PackageView[]>;
  install(source: string): Promise<PackageResult>;
  remove(source: string): Promise<PackageResult>;
}

/** Pi 패키지(확장) 관리: 목록, 설치(오래 걸림), 제거. 마지막 명령 출력을 보여 줄 수 있게 남긴다 */
export function usePackages(api: PackageApi, run: Run) {
  const [packages, setPackages] = useState<PackageView[]>();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<{ ok: boolean; output: string; action: string }>();
  const [changed, setChanged] = useState(false);
  const refresh = async () => setPackages(await api.list());
  useEffect(() => run(refresh), []);
  const act = (action: string, job: () => Promise<PackageResult>) =>
    run(async () => {
      setBusy(action);
      setResult(undefined);
      try {
        const r = await job();
        setPackages(r.packages);
        setResult({ ok: r.ok, output: r.output, action });
        if (r.ok) setChanged(true);
      } finally {
        setBusy(undefined);
      }
    });
  return {
    packages,
    source,
    setSource,
    busy,
    result,
    changed,
    refresh: () => run(refresh),
    /** 입력한 출처(또는 주어진 출처)를 설치한다. npm 이름만 적으면 npm:을 붙인다 */
    install: (given?: string) => {
      const raw = (given ?? source).trim();
      if (!raw) return;
      const full = /^(npm:|git:|https:\/\/)/.test(raw) ? raw : `npm:${raw}`;
      act(`설치: ${full}`, async () => {
        const r = await api.install(full);
        if (r.ok && given === undefined) setSource("");
        return r;
      });
    },
    remove: (pkg: string, question: string) => {
      if (!confirm(question)) return;
      act(`제거: ${pkg}`, () => api.remove(pkg));
    },
  };
}

export interface ImportApi {
  list(): Promise<Importables>;
  importSkill(from: AppId, name: string): Promise<void>;
  installPackage(source: string): Promise<PackageResult>;
}

/** 다른 앱에서 가져오기 (복사). 열 때 목록을 읽고, 가져온 뒤 다시 읽는다 */
export function useImports(api: ImportApi, run: Run, onImported?: () => void) {
  const [items, setItems] = useState<Importables>();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const load = async () => setItems(await api.list());
  const job = (label: string, work: () => Promise<string>) =>
    run(async () => {
      setBusy(label);
      setMessage(undefined);
      try {
        setMessage(await work());
        await load();
        onImported?.();
      } finally {
        setBusy(undefined);
      }
    });
  return {
    items,
    busy,
    message,
    load: () => run(load),
    importSkill: (from: AppId, name: string) =>
      job(`${name} 스킬`, async () => {
        await api.importSkill(from, name);
        return `${name} 스킬을 가져왔습니다.`;
      }),
    importPackage: (source: string) =>
      job(source, async () => {
        const r = await api.installPackage(source);
        if (!r.ok) throw new Error(`${source}를 설치하지 못했습니다\n${r.output.slice(-800)}`);
        return `${source}를 설치했습니다.`;
      }),
  };
}
