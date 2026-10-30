import { readChat, readInbox, type ChatLine, type InboxItem } from "@pi-desktop/mate-kit";
import { runCommand, freshItems } from "../chat/commands";
import type { ChatAgent } from "../chat/chat-agent";
import { delegateInboxItem } from "../delegate";
import { applyInboxChange, discardInboxChange } from "../inbox-change";
import { applyInstall, describeInstall } from "../install";
import { OBSERVER_DUTY_ID, OBSERVER_NAME } from "../observer";
import type { MatePaths } from "../paths";
import { listDuties, loadConfig, loadInboxState, readJson, setInboxStatus, writeJsonAtomic } from "../store";
import type { MateConfig } from "../types";
import type { Exec } from "../watchers";
import {
  chunks,
  confirmApplyButtons,
  HELP_TEXT,
  historyMessages,
  inQuietHours,
  itemButtons,
  itemText,
  mirrorText,
  optionButtons,
  parseCallback,
  parseCommand,
  parseOptionCallback,
  safe,
  shouldNotify,
  type Command,
} from "./messages";
import { TelegramApi, type TgUpdate } from "./telegram-api";

/** 실행기가 쓰는 휴대폰 연결 상태 (Mate 홈 remote.json). 앱은 읽기만 한다 */
export interface RemoteState {
  /** 이 상태가 어느 연결(설정의 pairEpoch) 것인지. 다르면 연결이 없는 것으로 본다 */
  epoch: number;
  chatId?: number;
  chatName?: string;
  pairedAt?: number;
  /** 다 쓴 짝짓기 코드 (다시 쓰지 못하게) */
  usedCode?: string;
  botName?: string;
  /** 텔레그램 getUpdates offset */
  offset?: number;
  /** 보낸 인박스 항목 → 메시지 id */
  sent: Record<string, { messageId: number; at: number }>;
  /** 보낸 대화 줄 → 메시지 id (질문에 답장하면 어느 질문인지 찾음) */
  chatSent: Record<string, { messageId: number; at: number }>;
  lastPollAt?: number;
  lastError?: string;
}

const MAX_SEND_PER_CYCLE = 5;
const POLL_TIMEOUT_SEC = 25;
const MONTH_MS = 30 * 24 * 3_600_000;

export function remoteStatePath(paths: MatePaths): string {
  return paths.remote;
}

export async function loadRemoteState(paths: MatePaths): Promise<RemoteState> {
  const raw = await readJson<Partial<RemoteState>>(paths.remote, {});
  return { epoch: raw.epoch ?? 0, ...raw, sent: raw.sent ?? {}, chatSent: raw.chatSent ?? {} } as RemoteState;
}

/** 휴대폰으로 보낼 대화 줄: 휴대폰에서 시작한 대화의 Mate 답, 그리고 (어디서 왔든) Mate의 질문 */
export function chatLineForPhone(line: ChatLine): boolean {
  return line.role === "mate" && line.kind !== "divider" && (line.source === "telegram" || line.kind === "question");
}

/**
 * "앱 대화도 휴대폰으로 보내기"를 켰을 때 함께 보낼 앱 대화 줄 (사용자가 앱에서 한 말과 그 답).
 * 켠 시각 뒤의 줄만 보낸다. 꺼져 있으면 아무것도 보내지 않는다.
 */
export function mirroredAppLine(line: ChatLine, telegram: Pick<MateConfig["telegram"], "mirrorApp" | "mirrorAppSince">): boolean {
  return telegram.mirrorApp && line.source === "app" && line.kind !== "divider" && line.at >= (telegram.mirrorAppSince ?? 0);
}

/**
 * 휴대폰(텔레그램) 연결 (설계 DESIGN-MATE.md §12, §13).
 * 실행기 안에서 따로 돌며(임무 실행 중에도 버튼에 바로 답하도록), 앱과 같은 동작만 한다:
 * 인박스 확인·버리기, 고친 변경 적용(한 번 더 묻기)·버리기, 맡기기·고치기 지시(설정에서 허용했을 때), 살펴보기 지시, 임무 실행.
 * 빗금 없는 말은 Mate 대화로 넘기고, 대화의 답·Mate 질문을 휴대폰으로 보낸다. 연결된 개인 채팅 한 곳의 명령만 받는다.
 */
export class TelegramRemote {
  private stopped = false;
  private abort = new AbortController();
  private readonly api: TelegramApi;
  /** 대화 줄 보내기를 한 줄로 세운다 (같은 줄을 두 번 보내지 않게) */
  private sending: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly paths: MatePaths,
    token: string,
    private readonly exec: Exec,
    private readonly log: (message: string) => void,
    private readonly chat: ChatAgent,
    private readonly now: () => number = Date.now,
    apiBase?: string,
  ) {
    this.api = new TelegramApi(token, apiBase);
  }

  start(): void {
    // 대화 답이 생기면 다음 폴링을 기다리지 않고 바로 보낸다. 앱 대화는 보낼지 설정을 보고 정한다
    this.unsubscribe = this.chat.onLine((line) => {
      if (chatLineForPhone(line) || line.source === "app") void this.flushChat();
    });
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.abort.abort();
  }

  private async loop(): Promise<void> {
    let backoff = 5_000;
    while (!this.stopped) {
      try {
        const active = await this.cycle();
        backoff = 5_000;
        if (!active) await sleep(15_000);
      } catch (error) {
        if (this.stopped) break;
        const message = (error as Error).message;
        this.log(`telegram error ${message}`);
        await this.patchState({ lastError: message }).catch(() => undefined);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 120_000);
      }
    }
  }

  /** 한 번 돈다: 받은 것 처리 → 보낼 것 보내기. 꺼져 있으면 false */
  async cycle(pollTimeoutSec = POLL_TIMEOUT_SEC): Promise<boolean> {
    const config = await loadConfig(this.paths);
    if (!config.telegram.enabled) return false;
    let state = await this.syncEpoch(config);
    if (!state.botName) {
      const me = await this.api.getMe();
      state = await this.patchState({ botName: me.username });
    }
    const updates = await this.api.getUpdates(state.offset, pollTimeoutSec, this.abort.signal);
    for (const update of updates) {
      await this.handleUpdate(update, config).catch((error: Error) => this.log(`telegram update error ${error.message}`));
      await this.patchState({ offset: update.update_id + 1 });
    }
    const after = await loadRemoteState(this.paths);
    if (after.chatId) await this.outbound(config, after);
    await this.patchState({ lastPollAt: this.now(), lastError: undefined });
    return true;
  }

  /** 설정의 연결 번호가 바뀌었으면(앱에서 연결 해제) 연결을 버린다 */
  private async syncEpoch(config: MateConfig): Promise<RemoteState> {
    const state = await loadRemoteState(this.paths);
    if (state.epoch === config.telegram.pairEpoch) return state;
    const next: RemoteState = { epoch: config.telegram.pairEpoch, sent: {}, chatSent: {}, ...(state.offset ? { offset: state.offset } : {}) };
    await writeJsonAtomic(this.paths.remote, next);
    return next;
  }

  private async patchState(patch: Partial<RemoteState>): Promise<RemoteState> {
    const state = { ...(await loadRemoteState(this.paths)), ...patch };
    for (const key of Object.keys(patch) as Array<keyof RemoteState>) if (patch[key] === undefined) delete state[key];
    await writeJsonAtomic(this.paths.remote, state);
    return state;
  }

  // ── 받은 것 ──

  private async handleUpdate(update: TgUpdate, config: MateConfig): Promise<void> {
    const state = await loadRemoteState(this.paths);
    if (update.message?.text !== undefined) {
      const chat = update.message.chat;
      if (chat.type !== "private") return; // 단체방은 받지 않는다
      const command = parseCommand(update.message.text);
      if (!state.chatId) {
        if (command?.kind === "start" && command.code) await this.tryPair(chat, command.code, config, state);
        else await this.api.sendMessage(chat.id, "Mate와 연결하려면 PC의 Mate 설정 → 휴대폰 연결에서 만든 코드를 <code>/start 코드</code>로 보내 주세요.");
        return;
      }
      if (chat.id !== state.chatId) return; // 연결된 채팅만
      const replyTo = update.message.reply_to_message?.message_id;
      if (command) await this.handleCommand(command, config, state, replyTo);
      return;
    }
    const cb = update.callback_query;
    if (cb?.message && state.chatId && cb.message.chat.id === state.chatId) {
      await this.handleCallback(cb.id, cb.data, cb.message.message_id, config);
    } else if (cb) {
      await this.api.answerCallback(cb.id, "연결되지 않은 채팅입니다");
    }
  }

  private async tryPair(chat: { id: number; first_name?: string; username?: string }, code: string, config: MateConfig, state: RemoteState): Promise<void> {
    const t = config.telegram;
    const valid = t.pairingCode && t.pairingExpires && this.now() < t.pairingExpires && code.trim() === t.pairingCode && state.usedCode !== t.pairingCode;
    if (!valid) {
      await this.api.sendMessage(chat.id, "코드가 맞지 않거나 시간이 지났어요. Mate 설정에서 새 코드를 만들어 주세요.");
      return;
    }
    const name = chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id));
    await this.patchState({ chatId: chat.id, chatName: name, pairedAt: this.now(), usedCode: t.pairingCode! });
    this.log(`telegram paired chat=${chat.id}`);
    await this.api.sendMessage(chat.id, `✅ 연결했어요. 이제 Mate 알림이 여기로 옵니다.\n\n${HELP_TEXT}`);
  }

  private async handleCommand(command: Command, config: MateConfig, state: RemoteState, replyTo?: number): Promise<void> {
    const chatId = state.chatId!;
    const say = (text: string) => this.api.sendMessage(chatId, text);
    switch (command.kind) {
      case "start":
      case "help":
        await say(HELP_TEXT);
        return;
      case "inbox": {
        // 버튼으로 바로 처리할 수 있게 항목마다 따로 보낸다
        const fresh = await freshItems(this.paths);
        if (fresh.length === 0) return void (await say("새 제안이 없어요."));
        const names = await this.dutyNames();
        for (const item of fresh.slice(0, 5)) await this.sendItem(item, names, config, chatId);
        if (fresh.length > 5) await say(`그 밖에 ${fresh.length - 5}건은 PC의 Mate에서 보세요.`);
        return;
      }
      case "history": {
        // 앱에서 나눈 말도 함께 보여 준다. 같은 Pi 세션이라 이어서 말하면 앞의 맥락을 기억한다
        for (const part of historyMessages(await readChat(this.paths.chat), command.count)) await say(part);
        return;
      }
      case "chat":
      case "new": {
        // 대화는 Mate 대화 담당이 한 번에 하나씩 답한다. 답은 대화 줄로 생겨 바로 보낸다
        const answerTo = replyTo ? Object.entries(state.chatSent).find(([, v]) => v.messageId === replyTo)?.[0] : undefined;
        if (this.chat.busy) await say("앞의 말에 답하는 중이에요. 이어서 답할게요.");
        await this.api.typing(chatId).catch(() => undefined);
        this.chat.submit({ text: command.kind === "new" ? "/new" : command.text, source: "telegram", ...(answerTo ? { answerTo } : {}) });
        return;
      }
      default: {
        // 나머지 "/" 명령은 앱 대화와 같은 처리 (결과는 대화 담당이 추적해 알린다)
        const text = await runCommand(
          {
            paths: this.paths,
            exec: this.exec,
            now: this.now,
            track: (dutyId, source) => this.chat.track(dutyId, source),
            source: "telegram",
            allowFix: config.telegram.allowFix,
          },
          command,
        );
        await say(safe(text, 3500));
      }
    }
  }

  private async handleCallback(id: string, data: string | undefined, messageId: number, config: MateConfig): Promise<void> {
    const state = await loadRemoteState(this.paths);
    const chatId = state.chatId!;
    const option = parseOptionCallback(data);
    if (option) return this.answerOption(id, option, messageId, chatId);
    const cb = parseCallback(data);
    if (!cb) return void (await this.api.answerCallback(id));
    const item = (await readInbox(this.paths.inbox)).find((i) => i.id === cb.itemId);
    if (!item) return void (await this.api.answerCallback(id, "이미 없는 항목이에요"));
    const handled = (await loadInboxState(this.paths))[item.id];
    const done = async (label: string) => {
      await this.api.editButtons(chatId, messageId, []);
      await this.api.answerCallback(id, label);
      await this.api.sendMessage(chatId, `${label}: ${safe(item.title, 120)}`);
      this.log(`telegram ${cb.action} item=${item.id}`);
    };
    if (handled && cb.action !== "view") {
      await this.api.editButtons(chatId, messageId, []);
      return void (await this.api.answerCallback(id, "이미 처리한 항목이에요"));
    }
    try {
      switch (cb.action) {
        case "confirmApply":
          await this.api.editButtons(chatId, messageId, confirmApplyButtons(item.id));
          return void (await this.api.answerCallback(id, item.install ? "Mate에 넣을까요?" : "PC의 작업 폴더에 적용할까요?"));
        case "cancel":
          await this.api.editButtons(chatId, messageId, itemButtons(item, config.telegram));
          return void (await this.api.answerCallback(id));
        case "apply":
          if (item.install) return void (await done(`✅ ${await applyInstall(this.paths, item.id)}`));
          await applyInboxChange(this.paths, item.id, this.exec);
          return void (await done("✅ 적용했어요 (커밋은 PC에서)"));
        case "discard":
          if (item.install) await setInboxStatus(this.paths, [item.id], "dismissed");
          else await discardInboxChange(this.paths, item.id, this.exec);
          return void (await done("🗑 버렸어요"));
        case "accept":
          await setInboxStatus(this.paths, [item.id], "accepted");
          return void (await done("👍 확인했어요"));
        case "dismiss":
          await setInboxStatus(this.paths, [item.id], "dismissed");
          return void (await done("🗑 버렸어요"));
        case "delegate": {
          if (!config.telegram.allowFix) return void (await this.api.answerCallback(id, "휴대폰에서 고치기는 설정에서 허용해야 해요"));
          const duty = await delegateInboxItem(this.paths, item.id, this.exec);
          await this.chat.track(duty.id, "telegram");
          return void (await done("🛠 맡겼어요. 끝나면 알려 드릴게요"));
        }
        case "view": {
          await this.api.answerCallback(id);
          if (!config.telegram.sendDetail) return;
          const text = [item.detail, item.install ? await describeInstall(item.install) : undefined].filter(Boolean).join("\n\n") || "(자세한 내용 없음)";
          for (const part of chunks(text)) await this.api.sendMessage(chatId, `<pre>${safe(part, 4000)}</pre>`);
          return;
        }
      }
    } catch (error) {
      await this.api.answerCallback(id, "실패했어요");
      await this.api.sendMessage(chatId, `⚠️ ${safe((error as Error).message, 400)}`);
    }
  }

  /** Mate 질문의 선택지를 눌렀다: 그 답을 대화로 넘긴다 */
  private async answerOption(id: string, option: { lineId: string; index: number }, messageId: number, chatId: number): Promise<void> {
    const lines = await readChat(this.paths.chat);
    const question = lines.find((l) => l.id === option.lineId && l.kind === "question");
    const answer = question?.options?.[option.index];
    if (!question || !answer) return void (await this.api.answerCallback(id, "이미 없는 질문이에요"));
    await this.api.editButtons(chatId, messageId, []);
    if (lines.some((l) => l.answerTo === question.id)) return void (await this.api.answerCallback(id, "이미 답한 질문이에요"));
    await this.api.answerCallback(id, `답: ${answer}`);
    await this.api.typing(chatId).catch(() => undefined);
    this.chat.submit({ text: answer, source: "telegram", answerTo: question.id });
  }

  // ── 보낼 것 ──

  private async outbound(config: MateConfig, state: RemoteState): Promise<void> {
    const chatId = state.chatId!;
    await this.flushChat();
    if (inQuietHours(config.telegram.quiet, this.now())) return;
    const fresh = (await freshItems(this.paths)).filter((i) => i.createdAt >= (state.pairedAt ?? 0) && !state.sent[i.id] && shouldNotify(i, config.telegram.notify));
    if (fresh.length === 0) return;
    const names = await this.dutyNames();
    // 오래된 것부터 보낸다
    for (const item of fresh.reverse().slice(0, MAX_SEND_PER_CYCLE)) await this.sendItem(item, names, config, chatId);
  }

  /**
   * 아직 보내지 않은 대화 줄(휴대폰 대화의 답·Mate 질문, 설정했으면 앱 대화)을 보낸다.
   * 질문은 조용한 시간을 지킨다. 앱 대화는 조용한 시간이면 보내지 않고 건너뛴다 (끝난 뒤 한꺼번에 쏟아지지 않게).
   */
  flushChat(): Promise<void> {
    this.sending = this.sending.then(() => this.sendChatLines()).catch((error: Error) => this.log(`telegram chat send error ${error.message}`));
    return this.sending;
  }

  private async sendChatLines(): Promise<void> {
    const [config, state] = await Promise.all([loadConfig(this.paths), loadRemoteState(this.paths)]);
    if (!config.telegram.enabled || !state.chatId) return;
    const lines = await readChat(this.paths.chat);
    const answered = new Set(lines.filter((l) => l.answerTo).map((l) => l.answerTo));
    const quiet = inQuietHours(config.telegram.quiet, this.now());
    const mirrored = (l: ChatLine) => mirroredAppLine(l, config.telegram);
    const todo = lines.filter(
      (l) =>
        (chatLineForPhone(l) || mirrored(l)) &&
        l.at >= (state.pairedAt ?? 0) &&
        !state.chatSent[l.id] &&
        !(l.kind === "question" && (answered.has(l.id) || quiet || (l.source === "app" && !mirrored(l)))),
    );
    if (todo.length === 0) return;
    const map = { ...state.chatSent };
    for (const line of todo.slice(0, MAX_SEND_PER_CYCLE)) {
      if (quiet && mirrored(line)) {
        // 보낸 것으로 쳐서 다시 보내지 않는다 (message_id 0: 실제로는 보내지 않음)
        map[line.id] = { messageId: 0, at: this.now() };
        continue;
      }
      const text = mirrored(line) ? mirrorText(line) : line.kind === "question" ? `❓ ${safe(line.text, 1500)}` : safe(line.text, 3500);
      const sent = await this.api.sendMessage(state.chatId, text, line.kind === "question" && line.options?.length ? optionButtons(line.id, line.options) : undefined);
      map[line.id] = { messageId: sent.message_id, at: this.now() };
    }
    for (const [k, v] of Object.entries(map)) if (this.now() - v.at > MONTH_MS) delete map[k];
    await this.patchState({ chatSent: map });
  }

  private async sendItem(item: InboxItem, names: Map<string, string>, config: MateConfig, chatId: number): Promise<void> {
    const sent = await this.api.sendMessage(chatId, itemText(item, names.get(item.dutyId) ?? item.dutyId), itemButtons(item, config.telegram));
    const state = await loadRemoteState(this.paths);
    const map = { ...state.sent, [item.id]: { messageId: sent.message_id, at: this.now() } };
    // 한 달 넘은 기록은 지운다
    for (const [k, v] of Object.entries(map)) if (this.now() - v.at > MONTH_MS) delete map[k];
    await this.patchState({ sent: map });
  }

  private async dutyNames(): Promise<Map<string, string>> {
    return new Map<string, string>([[OBSERVER_DUTY_ID, OBSERVER_NAME], ...(await listDuties(this.paths)).map((d) => [d.id, d.name] as [string, string])]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
