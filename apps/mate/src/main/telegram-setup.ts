import { net, safeStorage } from "electron";
import { randomInt } from "node:crypto";
import { TELEGRAM_TOKEN_ENV, type ConfigPatch, type MateConfig, type RemoteState } from "@pi-desktop/mate-runner";
import type { TelegramView } from "../shared/api";

/**
 * 휴대폰(텔레그램) 연결 설정 (설계 DESIGN-MATE.md §12). 앱 main에서만 돈다.
 *
 * 봇 토큰은 OS 키체인(Electron safeStorage)으로 암호화해 설정(config.json)에 두고, 실행기를 띄울 때만 풀어서
 * 환경 변수로 넘긴다. 실행기는 이를 Pi 실행 환경에 넘기지 않는다(모델이 볼 수 없게).
 * 설정은 실행기 RPC(mate.call)로 읽고 쓴다. 실행기를 띄우기 전에는 Mate 홈 파일을 직접 읽는 저장소를 넘긴다.
 */

/** 설정과 휴대폰 연결 상태를 읽고 쓰는 곳 (실행기 RPC 또는 로컬 파일) */
export interface TelegramStore {
  config(): Promise<MateConfig>;
  saveConfig(patch: ConfigPatch): Promise<unknown>;
  remoteState(): Promise<RemoteState>;
}
const API = process.env.PI_DESKTOP_MATE_TELEGRAM_API || "https://api.telegram.org";
const PAIRING_MS = 10 * 60_000;

async function tg<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await net.fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !body.ok) throw new Error(body.description ?? `HTTP ${res.status}`);
  return body.result as T;
}

/** 실행기에 넘길 환경 변수 (토큰이 있으면). 풀 수 없으면 비운다 */
export async function telegramEnv(store: TelegramStore): Promise<Record<string, string>> {
  const { telegram } = await store.config();
  if (!telegram.tokenEnc || !safeStorage.isEncryptionAvailable()) return {};
  try {
    return { [TELEGRAM_TOKEN_ENV]: safeStorage.decryptString(Buffer.from(telegram.tokenEnc, "base64")) };
  } catch {
    return {};
  }
}

/** 토큰을 확인(getMe)하고 암호화해 저장한다. 실행기는 호출한 쪽이 다시 띄운다 */
export async function saveTelegramToken(store: TelegramStore, token: string): Promise<void> {
  const trimmed = token.trim();
  if (!/^\d+:[\w-]{20,}$/.test(trimmed)) throw new Error("봇 토큰 형식이 아닙니다 (BotFather가 준 123456789:ABC… 형식)");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("이 PC에서 OS 키체인을 쓸 수 없어 토큰을 안전하게 저장할 수 없습니다");
  let me: { username: string };
  try {
    me = await tg<{ username: string }>(trimmed, "getMe");
  } catch (error) {
    throw new Error(`텔레그램에서 토큰을 확인하지 못했습니다: ${(error as Error).message} (회사 VPN·방화벽이 api.telegram.org를 막는지도 확인하세요)`);
  }
  const current = await store.config();
  await store.saveConfig({
    telegram: {
      enabled: true,
      tokenEnc: safeStorage.encryptString(trimmed).toString("base64"),
      botName: me.username,
      tokenHint: trimmed.slice(-4),
      // 다른 봇으로 바꾸면 기존 연결은 버린다
      pairEpoch: current.telegram.pairEpoch + 1,
    },
  });
}

/** 토큰과 연결을 지운다 */
export async function removeTelegram(store: TelegramStore): Promise<void> {
  const current = await store.config();
  await store.saveConfig({
    telegram: {
      enabled: false,
      tokenEnc: undefined,
      botName: undefined,
      tokenHint: undefined,
      pairingCode: undefined,
      pairingExpires: undefined,
      pairEpoch: current.telegram.pairEpoch + 1,
    },
  });
}

/** 10분짜리 일회용 연결 코드를 만든다 */
export async function createPairingCode(store: TelegramStore, now = Date.now()): Promise<void> {
  const code = String(randomInt(100_000, 1_000_000));
  await store.saveConfig({ telegram: { pairingCode: code, pairingExpires: now + PAIRING_MS } });
}

/** 연결 해제: 연결 번호를 올리면 실행기가 연결을 버린다 */
export async function unpairTelegram(store: TelegramStore): Promise<void> {
  const current = await store.config();
  await store.saveConfig({ telegram: { pairEpoch: current.telegram.pairEpoch + 1, pairingCode: undefined, pairingExpires: undefined } });
}

/** 연결된 채팅으로 시험 알림을 보낸다 */
export async function sendTelegramTest(store: TelegramStore): Promise<void> {
  const env = await telegramEnv(store);
  const token = env[TELEGRAM_TOKEN_ENV];
  const state = await store.remoteState();
  if (!token || !state.chatId) throw new Error("먼저 휴대폰을 연결하세요");
  await tg(token, "sendMessage", { chat_id: state.chatId, text: "🔔 Pi Desktop Mate 시험 알림입니다. 이 채팅으로 알림이 옵니다." });
}

export async function telegramView(store: TelegramStore, now = Date.now()): Promise<TelegramView> {
  const [config, state] = await Promise.all([store.config(), store.remoteState()]);
  const t = config.telegram;
  const paired = !!state.chatId && state.epoch === t.pairEpoch;
  return {
    hasToken: !!t.tokenEnc,
    ...(t.botName ? { botName: t.botName } : {}),
    ...(t.tokenHint ? { tokenHint: t.tokenHint } : {}),
    paired,
    ...(paired && state.chatName ? { chatName: state.chatName } : {}),
    ...(t.pairingCode && t.pairingExpires && t.pairingExpires > now && !paired ? { pairingCode: t.pairingCode, pairingExpires: t.pairingExpires } : {}),
    ...(state.lastPollAt ? { lastPollAt: state.lastPollAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    keychain: safeStorage.isEncryptionAvailable(),
  };
}
