import { readInbox, type InboxItem } from "@pi-desktop/mate-kit";
import { requestOneOff } from "../delegate";
import type { MatePaths } from "../paths";
import { folderAlias, resolveFolder, type Command } from "../remote/messages";
import { addRequest, listDuties, listRuns, loadConfig, loadInboxState, loadState } from "../store";
import type { Duty } from "../types";
import type { Exec } from "../watchers";

/**
 * "/"로 시작하는 명령을 모델 없이 바로 처리한다 (설계 DESIGN-MATE.md §13).
 * 앱 대화 탭과 텔레그램이 같은 처리를 쓴다. 답은 꾸밈 없는 글이다 (텔레그램은 보낼 때 이스케이프한다).
 */
export type ChatSource = "app" | "telegram";

export interface CommandContext {
  paths: MatePaths;
  exec: Exec;
  now: () => number;
  /** 실행을 요청했으면, 끝났을 때 결과를 이 대화 출처로 알리도록 기억한다 */
  track: (dutyId: string, source: ChatSource) => Promise<void>;
  source: ChatSource;
  /** 고치기(/fix)를 허용하는지 (텔레그램은 설정에 따름, 앱은 늘 허용) */
  allowFix: boolean;
}

export const COMMAND_HELP = [
  "명령은 /로 시작하고, 그냥 말로 해도 됩니다.",
  "/status — 실행기·오늘 실행·새 제안",
  "/inbox — 새 제안 목록",
  "/duties — 임무 목록",
  "/folders — 지시할 수 있는 폴더",
  "/run 임무 — 임무를 지금 실행",
  "/ask [폴더] 지시 — 읽기만 하며 살펴보기",
  "/fix [폴더] 지시 — 별도 작업 공간에서 고치기 (적용은 다시 묻기)",
  "/new — 새 대화 시작 (앞의 대화를 잊음)",
].join("\n");

/** 한 번만 도는 임무(휴대폰·대화 지시, 맡긴 일)인지 */
export function isOneOff(duty: Duty): boolean {
  return /^(phone|chat|delegated)-/.test(duty.id);
}

export async function freshItems(paths: MatePaths): Promise<InboxItem[]> {
  const [items, handled] = await Promise.all([readInbox(paths.inbox), loadInboxState(paths)]);
  return items.filter((i) => !handled[i.id]).sort((a, b) => b.createdAt - a.createdAt);
}

/** 지시할 수 있는 폴더: 임무 폴더 + 활동 관찰이 본 최근 작업 폴더 (중복 없이, 20개까지) */
export async function knownFolders(paths: MatePaths): Promise<string[]> {
  const duties = await listDuties(paths);
  const state = await loadState(paths);
  const all = [
    ...duties.filter((d) => !isOneOff(d)).map((d) => d.cwd),
    ...(state.observer?.recent.map((s) => s.cwd) ?? []),
    ...duties.map((d) => d.cwd),
  ];
  const seen = new Map<string, string>();
  for (const f of all) if (f && !seen.has(f.replace(/\\/g, "/").toLowerCase())) seen.set(f.replace(/\\/g, "/").toLowerCase(), f);
  return [...seen.values()].slice(0, 20);
}

export async function statusText(paths: MatePaths): Promise<string> {
  const [config, state, fresh] = await Promise.all([loadConfig(paths), loadState(paths), freshItems(paths)]);
  const cost = state.today.costUsd ? ` · 오늘 비용 $${state.today.costUsd.toFixed(3)}` : "";
  return [
    `실행기: 동작 중${state.current ? ` (지금 실행 중: ${state.current.dutyId})` : ""}`,
    `오늘 자동 실행 ${state.today.count}/${config.dailyRunLimit}회${cost}`,
    `새 제안 ${fresh.length}건${config.paused ? " · 일시 정지 중" : ""}`,
    `모델: ${config.model || "Pi 기본 모델"}`,
    `활동 관찰: ${config.observe.enabled ? "켜짐" : "꺼짐"}`,
  ].join("\n");
}

export async function findDuty(paths: MatePaths, query: string): Promise<Duty | undefined> {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const duties = (await listDuties(paths)).filter((d) => !isOneOff(d));
  return duties.find((d) => d.id === q) ?? duties.find((d) => d.name.toLowerCase() === q) ?? duties.find((d) => d.name.toLowerCase().includes(q));
}

/** 폴더 이름(마지막 폴더명)이나 경로로 아는 폴더를 찾는다 */
export async function findFolder(paths: MatePaths, nameOrPath: string | undefined): Promise<string | undefined> {
  const folders = await knownFolders(paths);
  if (!nameOrPath) return folders.length === 1 ? folders[0] : undefined;
  const q = nameOrPath.trim().replace(/\\/g, "/").toLowerCase();
  return folders.find((f) => f.replace(/\\/g, "/").toLowerCase() === q) ?? folders.find((f) => folderAlias(f) === folderAlias(q));
}

/** 살펴보기(ask)·고치기(fix) 지시를 한 번만 도는 임무로 실행한다 */
export async function instruct(ctx: CommandContext, kind: "ask" | "fix", folder: string, prompt: string): Promise<string> {
  if (kind === "fix" && !ctx.allowFix) {
    return "휴대폰에서 고치기는 꺼져 있어요. PC의 Mate 휴대폰 탭에서 허용할 수 있어요. 지금은 살펴보기만 할 수 있어요.";
  }
  const duty = await requestOneOff(
    ctx.paths,
    { idPrefix: ctx.source === "telegram" ? "phone" : "chat", name: `${ctx.source === "telegram" ? "휴대폰" : "대화"} 지시: ${prompt}`, cwd: folder, prompt, wantAct: kind === "fix" },
    ctx.exec,
    ctx.now(),
  );
  await ctx.track(duty.id, ctx.source);
  const how = duty.profile === "act" ? "별도 작업 공간에서 고치고, 적용은 다시 물을게요" : "읽기만 하며 살펴보고 결과를 알려 드릴게요";
  return `📝 ${folderAlias(folder)}에서 할게요: ${prompt}\n${how}.`;
}

export async function runCommand(ctx: CommandContext, command: Exclude<Command, { kind: "chat" | "start" }>): Promise<string> {
  const { paths } = ctx;
  switch (command.kind) {
    case "help":
      return COMMAND_HELP;
    case "status":
      return statusText(paths);
    case "inbox": {
      const fresh = await freshItems(paths);
      if (fresh.length === 0) return "새 제안이 없어요.";
      const label: Record<InboxItem["severity"], string> = { info: "참고", warn: "확인 필요", action: "할 일" };
      return fresh
        .slice(0, 10)
        .map((i) => `• [${label[i.severity]}] ${i.title}${i.change ? " (고친 변경)" : ""}`)
        .join("\n");
    }
    case "duties": {
      const duties = (await listDuties(paths)).filter((d) => !isOneOff(d));
      return duties.length ? duties.map((d) => `• ${d.name} (${d.id})`).join("\n") : "임무가 없어요.";
    }
    case "folders": {
      const folders = await knownFolders(paths);
      return folders.length ? folders.map((f) => `• ${folderAlias(f)} — ${f}`).join("\n") : "아는 폴더가 없어요. 임무를 하나 만들어 주세요.";
    }
    case "run": {
      const duty = await findDuty(paths, command.query);
      if (!duty) return "그 임무를 찾지 못했어요. /duties로 목록을 보세요.";
      await addRequest(paths, duty.id, ctx.now());
      await ctx.track(duty.id, ctx.source);
      return `▶ ${duty.name}을(를) 실행할게요. 끝나면 알려 드릴게요.`;
    }
    case "ask":
    case "fix": {
      if (!command.text) return `무엇을 할지 함께 써 주세요. 예: /${command.kind} 폴더이름 할 일`;
      const folders = await knownFolders(paths);
      const { folder, rest } = resolveFolder(command.text, folders);
      if (!folder || !rest) {
        return folders.length
          ? `어느 폴더인지 앞에 써 주세요: ${folders.map(folderAlias).join(", ")}`
          : "아는 폴더가 없어요. 임무를 하나 만들어 주세요.";
      }
      return instruct(ctx, command.kind, folder, rest);
    }
    case "new":
      return "새 대화를 시작했어요.";
    case "history":
      // 휴대폰용 명령이다. 앱 대화 탭에는 대화가 모두 보인다
      return "지금까지의 대화는 이 화면에 모두 있어요. /history는 휴대폰에서 앱 대화를 볼 때 씁니다.";
  }
}

/** 최근 실행 몇 개 (대화 맥락용) */
export async function recentRunsText(paths: MatePaths, limit = 5): Promise<string> {
  const runs = (await listRuns(paths, limit)).filter((r) => r.status !== "running");
  return runs.map((r) => `• ${r.dutyName}: ${r.status}${r.summary ? ` — ${r.summary.slice(0, 160)}` : r.error ? ` — ${r.error.slice(0, 120)}` : ""}`).join("\n");
}
