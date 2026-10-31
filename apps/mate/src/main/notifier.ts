import type { Overview } from "../shared/api";

/**
 * PC 알림 (설계 DESIGN-MATE.md §2 "알림"). 실행기가 "바뀌었다"고 알릴 때마다 overview를 앞의 것과 견줘
 * 새로 생긴 것만 알린다: Mate의 대화 답·질문(승인 요청 포함)·실행 결과, 끝난 임무, 새 제안.
 * 처음 읽은 overview는 기준만 잡는다 (앱을 켜자마자 지난 것이 쏟아지지 않게).
 */

export interface Note {
  title: string;
  body: string;
}

/** 이미 알린 것 */
export interface NoteState {
  chat: Set<string>;
  runs: Set<string>;
  inbox: Set<string>;
}

/** 한 번에 띄우는 알림 수. 넘으면 나머지는 한 줄로 묶는다 */
const MAX_NOTES = 3;
const clip = (text: string, n = 160) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

export function noteState(overview: Overview): NoteState {
  return {
    chat: new Set(overview.chat.lines.map((l) => l.id)),
    runs: new Set(overview.runs.filter((r) => r.status !== "running").map((r) => r.id)),
    inbox: new Set(overview.inbox.map((i) => i.id)),
  };
}

export function newNotes(prev: NoteState | undefined, overview: Overview): { notes: Note[]; state: NoteState } {
  const state = noteState(overview);
  if (!prev) return { notes: [], state };
  const notes: Note[] = [];
  // 대화 줄에 결과가 있는 실행은 따로 알리지 않는다
  const coveredRuns = new Set<string>();
  for (const line of overview.chat.lines) {
    if (prev.chat.has(line.id) || line.role !== "mate") continue;
    if (line.runId) coveredRuns.add(line.runId);
    if (line.kind === "question") notes.push({ title: "Mate의 질문", body: clip(line.text) });
    // 휴대폰에서 나눈 대화의 답·결과는 휴대폰으로 간다
    else if ((line.kind === "reply" || line.kind === "result") && line.source !== "telegram") {
      notes.push({ title: line.kind === "reply" ? "Mate" : "Mate 실행 결과", body: clip(line.text) });
    }
  }
  const notedRuns = new Set<string>();
  for (const run of overview.runs) {
    if (run.status === "running" || prev.runs.has(run.id) || coveredRuns.has(run.id)) continue;
    notedRuns.add(run.id);
    const ok = run.status === "done";
    const proposals = run.proposals ? ` · 제안 ${run.proposals}건` : "";
    notes.push({ title: `임무 ${ok ? "완료" : "실패"}: ${run.dutyName}${proposals}`, body: clip((ok ? run.summary : run.error) ?? "") });
  }
  for (const item of overview.inbox) {
    if (prev.inbox.has(item.id) || item.status || notedRuns.has(item.runId) || coveredRuns.has(item.runId)) continue;
    notes.push({ title: `새 제안: ${clip(item.title, 60)}`, body: clip(item.summary) });
  }
  if (notes.length <= MAX_NOTES) return { notes, state };
  const rest = notes.length - (MAX_NOTES - 1);
  return { notes: [...notes.slice(0, MAX_NOTES - 1), { title: `Mate 알림 ${rest}건 더`, body: "앱에서 확인하세요" }], state };
}
