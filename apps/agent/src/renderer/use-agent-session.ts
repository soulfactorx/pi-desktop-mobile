import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEventNotification, SessionSummary } from "@pi-desktop/host-protocol/messages";
import { STATUS_COMMAND } from "@pi-desktop/agent-kit/constants";
import { addNotice, applyEvent, initialChatState, snapshotState, type ChatState } from "../vendor/renderer/chat-state";
import {
  applyUiEvent,
  dialogResponse,
  dismissToast,
  initialExtensionUiState,
  prunePending,
  resolveDialog,
  type DialogRequest,
  type ExtensionUiState,
} from "../vendor/renderer/extension-ui-state";
import type { ConnectionState, SessionSource } from "../shared/api";

/** 모델 하나 (프로바이더·ID·이름) */
export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
  /** 받는 입력 (예: ["text", "image"]) */
  input?: string[];
}

/** agent-kit이 세션에 올라갔는지 (설계 DESIGN-AGENT.md §2.1) */
export type KitState = "checking" | "ready" | "missing";

const api = () => window.piAgent;

/**
 * 에이전트 앱의 세션 하나.
 *
 * Pi Desktop의 use-session을 줄인 것이다. 로컬 호스트 하나, 한 번에 세션 하나(새로 열기·돌고 있는 세션으로 바꾸기)를 다루고
 * 팔로우·여러 앱 입력 권한·신뢰 묻기는 두지 않는다. 이벤트 해석은 Pi Desktop의 리듀서(chat-state,
 * extension-ui-state)를 그대로 쓴다.
 */
export function useAgentSession() {
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting" });
  const [session, setSession] = useState<SessionSummary>();
  /** Pi를 띄워 대화를 여는 중인 폴더 (없으면 여는 중이 아님) */
  const [opening, setOpening] = useState<string>();
  const openingRef = useRef(false);
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [ui, setUi] = useState<ExtensionUiState>(initialExtensionUiState);
  const [kit, setKit] = useState<KitState>();
  const [model, setModel] = useState<ModelRef>();
  const [models, setModels] = useState<ModelRef[]>([]);
  const sessionRef = useRef<SessionSummary>(undefined);
  /** attach 중에 알림으로 온 이벤트. 결과를 적용한 뒤에 순번으로 걸러 적용한다 */
  const attachQueueRef = useRef<SessionEventNotification[]>(undefined);

  const applyNotification = useCallback((n: SessionEventNotification, replay: boolean) => {
    setChat((prev) => applyEvent(prev, n.seq, n.event));
    setUi((prev) => applyUiEvent(prev, n.seq, n.at, n.event, Date.now(), replay));
  }, []);

  const notice = useCallback((level: "info" | "error", text: string) => {
    setChat((prev) => addNotice(prev, level, text));
  }, []);

  useEffect(() => {
    void api().connectionState().then(setConnection);
    const offConnection = api().onConnection(setConnection);
    const offEvent = api().onSessionEvent((n) => {
      if (n.sessionId !== sessionRef.current?.sessionId) return;
      if (attachQueueRef.current) attachQueueRef.current.push(n);
      else applyNotification(n, false);
    });
    const offExit = api().onSessionExit((n) => {
      if (n.sessionId !== sessionRef.current?.sessionId) return;
      const detail = n.stderrTail.trim().split("\n").slice(-5).join("\n");
      notice("error", `Pi 프로세스가 종료되었습니다 (code ${n.exitCode ?? n.signal})${detail ? `\n${detail}` : ""}`);
    });
    const offResolved = api().onUiResolved((n) => {
      if (n.sessionId === sessionRef.current?.sessionId) setUi((prev) => resolveDialog(prev, n.id));
    });
    return () => {
      offConnection();
      offEvent();
      offExit();
      offResolved();
    };
  }, [applyNotification, notice]);

  /** agent-kit 확장 명령이 세션에 있는지 본다. 없으면 기능 없이 Pi만 도는 상태다 */
  const checkKit = useCallback(async (sessionId: string) => {
    setKit("checking");
    const response = await api().sendCommand(sessionId, { type: "get_commands" });
    const commands = (response.data as { commands?: Array<{ name?: string }> } | undefined)?.commands ?? [];
    setKit(commands.some((c) => c.name === STATUS_COMMAND) ? "ready" : "missing");
  }, []);

  /** 세션의 지금 모델과 고를 수 있는 모델을 읽는다 */
  const refreshModel = useCallback(async (sessionId: string) => {
    const state = await api().sendCommand(sessionId, { type: "get_state" });
    const current = (state.data as { model?: ModelRef } | undefined)?.model;
    setModel(current ? { provider: current.provider, id: current.id, name: current.name, input: current.input } : undefined);
    const available = await api().sendCommand(sessionId, { type: "get_available_models" });
    const list = (available.data as { models?: ModelRef[] } | undefined)?.models ?? [];
    setModels(list.map((m) => ({ provider: m.provider, id: m.id, name: m.name, input: m.input })));
  }, []);

  /** 세션에 처음부터 붙는다. 저널 앞부분이 잘렸으면 Pi가 가진 대화 전체로 다시 그린다 */
  const attachTo = useCallback(
    async (target: SessionSummary) => {
      setChat(initialChatState);
      setUi(initialExtensionUiState);
      setKit(undefined);
      setModel(undefined);
      // attach 이후의 실시간 이벤트가 걸러지지 않도록 대상 세션을 먼저 지정한다.
      sessionRef.current = target;
      setSession(target);
      const queued: SessionEventNotification[] = [];
      attachQueueRef.current = queued;
      let truncated = false;
      let lastSeq = 0;
      try {
        const result = await api().attachSession(target.sessionId, 0);
        // 재생 이벤트를 먼저, 그 사이 알림으로 온 것을 나중에 적용한다 (리듀서가 순번으로 중복을 거름).
        for (const n of result.events) applyNotification(n, true);
        for (const n of queued) applyNotification(n, false);
        setUi((prev) => prunePending(prev, result.pendingUi ?? []));
        setSession(result.session);
        truncated = result.truncated;
        lastSeq = result.session.lastSeq;
      } finally {
        attachQueueRef.current = undefined;
      }
      // 저널 앞부분이 잘렸거나, 다른 세션에서 분기해 연 대화(저널에는 분기 전 대화가 없다)면 Pi가 가진 대화 전체로 다시 그린다
      const messages = await api().sendCommand(target.sessionId, { type: "get_messages" });
      const list = (messages.data as { messages?: unknown[] } | undefined)?.messages ?? [];
      setChat((prev) => (truncated || (prev.items.length === 0 && list.length > 0) ? snapshotState(list, Math.max(prev.lastSeq, lastSeq), prev.running) : prev));
      await Promise.all([checkKit(target.sessionId), refreshModel(target.sessionId).catch(() => undefined)]);
    },
    [applyNotification, checkKit, refreshModel],
  );

  /**
   * 새 세션을 열고 붙는다. forkFrom을 주면 그 세션 파일의 대화를 이어 가는 새 세션으로 연다 (pi --fork)
   * Pi를 띄우는 데 몇 초 걸리므로 여는 동안 opening으로 알리고, 그 사이 온 요청은 무시한다 (여러 번 눌러도 하나만 열림).
   * @returns 열었으면 true, 이미 여는 중이라 무시했으면 false
   */
  const open = useCallback(
    async (cwd: string, from?: SessionSource): Promise<boolean> => {
      if (openingRef.current) return false;
      openingRef.current = true;
      setOpening(cwd);
      try {
        const opened = await api().openSession(cwd, from);
        await attachTo(opened);
        return true;
      } finally {
        openingRef.current = false;
        setOpening(undefined);
      }
    },
    [attachTo],
  );

  /**
   * 지금 대화를 다른 폴더로 옮긴다 (설계 DESIGN-AGENT.md §4 "작업 폴더").
   * Pi 세션의 폴더는 프로세스마다 고정이라, 대화가 있으면 지금 세션 파일에서 분기한 새 세션을 그 폴더에서 연다.
   * 지금까지의 대화를 이어 가고, 원래 대화는 그대로 남는다. 아직 아무 말도 없으면 새로 열고 빈 원래 대화는 닫는다.
   */
  const moveTo = useCallback(
    async (folder: string) => {
      const current = sessionRef.current;
      if (!current) {
        await open(folder);
        return;
      }
      const state = await api().sendCommand(current.sessionId, { type: "get_state" });
      const data = state.data as { sessionFile?: string; messageCount?: number; isStreaming?: boolean } | undefined;
      if (data?.isStreaming) throw new Error("응답하는 중에는 폴더를 바꿀 수 없습니다. 끝난 뒤 다시 시도하세요.");
      if (!data?.messageCount || !data.sessionFile) {
        // 다른 대화를 여는 중이라 열지 않았으면 원래 대화도 그대로 둔다.
        if (await open(folder)) await api().closeSession(current.sessionId);
        return;
      }
      await open(folder, { forkFrom: data.sessionFile });
    },
    [open],
  );

  /** 이 세션의 모델을 바꾼다 (Pi의 기본 모델·프로바이더 설정은 Pi Desktop에서) */
  const changeModel = useCallback(
    async (provider: string, id: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const response = await api().sendCommand(current.sessionId, { type: "set_model", provider, modelId: id });
      if (response.success === false) throw new Error(String(response.error ?? "모델을 바꾸지 못했습니다"));
      await refreshModel(current.sessionId);
    },
    [refreshModel],
  );

  /** 지금 세션을 닫는다 (Pi 프로세스를 끝낸다. 대화 기록 파일은 Pi 세션 폴더에 남는다) */
  const close = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    await api().closeSession(current.sessionId);
    sessionRef.current = undefined;
    setSession(undefined);
    setChat(initialChatState);
    setUi(initialExtensionUiState);
    setKit(undefined);
    setModel(undefined);
  }, []);

  /** 프롬프트를 보낸다. 응답 중이면 끝난 뒤에 이어서 처리하도록 follow-up으로 넣는다 */
  const send = useCallback(
    async (message: string, images: Array<{ mimeType: string; data: string }> = []) => {
      const current = sessionRef.current;
      if (!current) return;
      const response = await api().sendCommand(current.sessionId, {
        type: "prompt",
        message,
        ...(images.length > 0 ? { images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
        ...(chat.running ? { streamingBehavior: "followUp" } : {}),
      });
      if (response.success === false) notice("error", String(response.error ?? "보내지 못했습니다"));
    },
    [chat.running, notice],
  );

  const abort = useCallback(async () => {
    const current = sessionRef.current;
    if (current) await api().sendCommand(current.sessionId, { type: "abort" });
  }, []);

  const answer = useCallback(
    async (dialog: DialogRequest, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      const current = sessionRef.current;
      if (!current) return;
      setUi((prev) => resolveDialog(prev, dialog.id));
      await api().sendRecord(current.sessionId, dialogResponse(dialog, reply));
    },
    [],
  );

  const dismiss = useCallback((key: string) => setUi((prev) => dismissToast(prev, key)), []);

  return { connection, session, opening, chat, ui, kit, model, models, open, attachTo, moveTo, changeModel, close, send, abort, answer, dismiss, notice };
}
