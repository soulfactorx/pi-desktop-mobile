import { useCallback, useEffect, useState } from "react";
import type { Overview, TelegramView } from "../shared/api";
import type { Act } from "./App";
import { relativeTime } from "./mate-view";

/**
 * 휴대폰(텔레그램) 연결 (설계 DESIGN-MATE.md §12).
 * 1) 봇 토큰 저장 → 2) 연결 코드로 짝짓기 → 3) 알림 범위·조용한 시간·고치기 허용
 * 원격 호스트면 그 호스트의 실행기가 텔레그램에 붙고, 토큰은 앱이 붙을 때 넘겨 실행기 메모리에만 둔다 (DESIGN-MATE-REMOTE.md §5).
 */
export function PhoneView({ overview, act, remoteHost }: { overview: Overview; act: Act; remoteHost?: string }) {
  const t = overview.config.telegram;
  const [view, setView] = useState<TelegramView>();
  const [token, setToken] = useState("");
  const [now, setNow] = useState(Date.now());
  const refresh = useCallback(() => void window.mate.telegramView().then(setView), []);
  useEffect(() => {
    refresh();
    // 짝짓기를 기다리는 동안·연결 상태를 자주 다시 읽는다
    const timer = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 3_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const run = (job: () => Promise<TelegramView | void>) =>
    void act(async () => {
      const next = await job();
      if (next) setView(next);
      else refresh();
    });
  const save = (patch: Partial<typeof t>) => run(async () => void (await window.mate.saveConfig({ telegram: patch })));

  if (!view) return <div className="muted">불러오는 중…</div>;

  return (
    <div className="form phone">
      <p className="muted small-text">
        휴대폰 텔레그램으로 Mate 알림을 받고, 버튼으로 확인·적용·버리기·맡기기를 하고, 채팅으로 지시할 수 있습니다. PC의 실행기가 텔레그램에
        바깥으로만 연결하므로 포트를 열 필요가 없습니다. 보내는 글은 비밀값을 가리고 줄여서 보냅니다(텔레그램 서버를 거칩니다).
      </p>

      {remoteHost && (
        <p className="muted small-text">
          지금 호스트는 {remoteHost}입니다. 그 호스트의 실행기가 텔레그램에 연결합니다(그 호스트에서 api.telegram.org에 나갈 수 있어야 합니다). 봇 토큰은 이
          PC의 키체인으로 암호화해 두고, 앱이 붙을 때마다 풀어서 실행기에 넘깁니다. 실행기는 토큰을 메모리에만 두므로, 그 호스트의 실행기가 다시 뜨면 이
          앱이 다시 붙을 때까지 휴대폰 연결이 쉽니다.
        </p>
      )}
      {view.hasToken && !overview.runner.phone && overview.runner.alive && (
        <div className="bad-text small-text">
          휴대폰 연결이 쉬고 있습니다. 실행기가 아직 토큰을 받지 못했습니다{remoteHost ? " (다른 PC에서 저장한 토큰이면 이 PC에서는 풀 수 없으니 토큰을 다시 저장하세요)" : ""}.
        </div>
      )}

      {!view.hasToken ? (
        <>
          <ol className="steps">
            <li>
              텔레그램에서 <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>에게 <code>/newbot</code>을 보내 봇을 만듭니다
              (이름은 자유, 예: my_pi_mate_bot).
            </li>
            <li>BotFather가 준 토큰(<code>123456789:ABC…</code>)을 아래에 붙여 넣습니다. OS 키체인으로 암호화해 저장하며, 이 PC에서만 풀 수 있습니다.</li>
          </ol>
          {!view.keychain && <div className="bad-text">이 PC에서 OS 키체인을 쓸 수 없어 토큰을 저장할 수 없습니다.</div>}
          <div className="row">
            <input className="grow" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="봇 토큰" />
            <button
              className="primary"
              disabled={!token.trim() || !view.keychain}
              onClick={() =>
                run(async () => {
                  const next = await window.mate.telegramSetToken(token);
                  setToken("");
                  return next;
                })
              }
            >
              확인하고 저장
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="kv">
            <span>봇</span>
            <span>
              @{view.botName} <span className="muted">(토큰 …{view.tokenHint})</span>
            </span>
            <span>휴대폰</span>
            <span>{view.paired ? `연결됨: ${view.chatName}` : "연결 안 됨"}</span>
            <span>실행기 연결</span>
            <span className={view.lastError ? "bad-text" : ""}>
              {view.lastError ? `오류: ${view.lastError}` : view.lastPollAt ? `정상 (${relativeTime(view.lastPollAt, now)})` : "확인 중…"}
            </span>
          </div>
          <label className="radio">
            <input type="checkbox" checked={t.enabled} onChange={() => save({ enabled: !t.enabled })} />
            <strong>휴대폰 연결 켜기</strong>
          </label>

          {!view.paired && (
            <div className="pairing">
              {view.pairingCode ? (
                <>
                  <div>
                    휴대폰 텔레그램에서 <b>@{view.botName}</b>에게 이렇게 보내세요 ({relativeTime(view.pairingExpires!, now)}까지):
                  </div>
                  <div className="code">/start {view.pairingCode}</div>
                  <a href={`https://t.me/${view.botName}?start=${view.pairingCode}`} target="_blank" rel="noreferrer">
                    또는 이 링크를 휴대폰에서 열기 (t.me/{view.botName})
                  </a>
                </>
              ) : (
                <button className="primary" disabled={!t.enabled} onClick={() => run(() => window.mate.telegramPair())}>
                  연결 코드 만들기
                </button>
              )}
            </div>
          )}

          {view.paired && (
            <>
              <div className="row">
                <button onClick={() => run(() => window.mate.telegramTest())}>시험 알림 보내기</button>
                <button onClick={() => run(() => window.mate.telegramUnpair())}>연결 해제</button>
              </div>
              <fieldset>
                <legend>알림</legend>
                <label className="radio">
                  <input type="radio" checked={t.notify === "action"} onChange={() => save({ notify: "action" })} />
                  할 일·확인 필요·고친 변경만
                </label>
                <label className="radio">
                  <input type="radio" checked={t.notify === "all"} onChange={() => save({ notify: "all" })} />
                  전부 (참고·보고 결과 포함)
                </label>
                <QuietHours quiet={t.quiet} onChange={(quiet) => save({ quiet })} />
                <label className="radio">
                  <input type="checkbox" checked={t.sendDetail} onChange={() => save({ sendDetail: !t.sendDetail })} />
                  diff·근거 내용도 보내기 <span className="muted">(끄면 제목·요약만 갑니다)</span>
                </label>
                <label className="radio">
                  <input
                    type="checkbox"
                    checked={t.mirrorApp}
                    // 켠 뒤의 대화만 보낸다. 켜자마자 지난 대화가 한꺼번에 가지 않게 켠 시각을 남긴다
                    onChange={() => save(t.mirrorApp ? { mirrorApp: false } : { mirrorApp: true, mirrorAppSince: Date.now() })}
                  />
                  앱 대화도 휴대폰으로 보내기{" "}
                  <span className="muted">(앱에서 나눈 말과 답을 🖥 표시로 보냅니다. 조용한 시간에는 건너뛰고, 지난 대화는 /history로 봅니다)</span>
                </label>
              </fieldset>
              <fieldset>
                <legend>휴대폰에서 할 수 있는 일</legend>
                <div className="muted small-text">확인함·버리기, 고친 변경 적용(한 번 더 묻기)·버리기, /ask 살펴보기 지시, /run 임무 실행은 늘 됩니다.</div>
                <label className="radio">
                  <input type="checkbox" checked={t.allowFix} onChange={() => save({ allowFix: !t.allowFix })} />
                  고치기 허용 <span className="muted">(/fix 지시, "Mate에게 맡기기": 별도 작업 공간에서 고치고 적용은 다시 묻습니다)</span>
                </label>
              </fieldset>
            </>
          )}
          <div className="row">
            <button className="danger small" onClick={() => run(() => window.mate.telegramRemove())}>
              봇 토큰 지우기
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QuietHours({ quiet, onChange }: { quiet: { start: string; end: string } | undefined; onChange: (q: { start: string; end: string } | undefined) => void }) {
  const [start, setStart] = useState(quiet?.start ?? "23:00");
  const [end, setEnd] = useState(quiet?.end ?? "08:00");
  return (
    <div className="row">
      <label className="radio">
        <input type="checkbox" checked={!!quiet} onChange={() => onChange(quiet ? undefined : { start, end })} />
        조용한 시간
      </label>
      <input type="time" value={start} disabled={!quiet} onChange={(e) => setStart(e.target.value)} onBlur={() => quiet && onChange({ start, end })} />
      <span>~</span>
      <input type="time" value={end} disabled={!quiet} onChange={(e) => setEnd(e.target.value)} onBlur={() => quiet && onChange({ start, end })} />
      <span className="muted small-text">이 동안 생긴 알림은 끝나면 보냅니다</span>
    </div>
  );
}
