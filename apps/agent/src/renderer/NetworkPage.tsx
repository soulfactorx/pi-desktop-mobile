import { useEffect, useState } from "react";
import type { AgentCard, CardDraft, NetworkState } from "../shared/network";

/**
 * 에이전트 네트워크 (설계 DESIGN-AGENT.md §4 "에이전트 네트워크(A2A)").
 * 다른 사람의 Pi Desktop Agent와 카드를 주고받고(페어링), 서로 질문할 수 있게 한다. 지식은 옮기지 않고 답만 준다.
 * 수신 서버는 스케줄러 세션이 이 설정을 읽어 띄운다 (앱을 닫아도 데몬이 떠 있으면 받는다).
 */
export function NetworkPage({ onError, pickFolder }: { onError: (message: string) => void; /** 그 호스트의 폴더를 고른다 (원격이면 데몬으로 훑음) */ pickFolder: () => Promise<string | undefined> }) {
  const [state, setState] = useState<NetworkState>();
  const [card, setCard] = useState<CardDraft>();
  const [address, setAddress] = useState("");
  const [preview, setPreview] = useState<AgentCard>();
  const [busy, setBusy] = useState(false);
  /** 카드 초안을 만드는 중인가, 만든 뒤 안내 */
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState(false);
  /** 들어온 작업마다 고른 폴더 */
  const [folders, setFolders] = useState<Record<string, string>>({});

  const run = (action: () => Promise<void>) =>
    action().catch((error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));
  const refresh = async () => {
    const next = await window.piAgent.networkState();
    setState(next);
    setCard((prev) => prev ?? next.card);
  };

  // 들어온 요청·페어링 결과를 보려고 화면이 열려 있는 동안 자주 읽는다
  useEffect(() => {
    void run(refresh);
    const timer = setInterval(() => {
      void window.piAgent.checkPairings().then(refresh, () => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  if (!state || !card) return <div className="page"><p className="muted page-body">읽는 중…</p></div>;
  const s = state.settings;

  return (
    <div className="page">
      <header className="page-head">
        <h2>네트워크</h2>
        <span className="muted">다른 사람의 에이전트와 연결해 서로 물어봅니다. 지식은 넘기지 않고 답만 줍니다</span>
      </header>
      <div className="page-body">
        {/* 사람이 답해야 하는 요청을 맨 위에 둔다 */}
        {state.taskRequests.length > 0 && (
          <section className="card">
            <h3>들어온 작업 요청</h3>
            <p className="muted small-text">
              승인하면 고른 폴더 안에서만 파일을 읽고 씁니다. 명령 실행·웹 요청·기억 바꾸기는 막혀 있고, 결과는 맡긴 쪽으로 돌아갑니다. 맡길 일에 필요한 파일만 있는 폴더를 고르세요.
            </p>
            <ul className="list">
              {state.taskRequests.map((t) => (
                <li key={t.id} className="network-task">
                  <div className="grow">
                    <strong>{t.title}</strong> <span className="muted small-text">{t.peerName}가 맡김</span>
                    <pre className="network-instruction">{t.instruction}</pre>
                    <button
                      className="small link-button"
                      onClick={() =>
                        run(async () => {
                          const folder = await pickFolder();
                          if (folder) setFolders((prev) => ({ ...prev, [t.id]: folder }));
                        })
                      }
                    >
                      📁 {folders[t.id] ?? "작업할 폴더 고르기"}
                    </button>
                  </div>
                  <button
                    className="small primary"
                    disabled={!folders[t.id]}
                    title={folders[t.id] ? "" : "먼저 작업할 폴더를 고르세요"}
                    onClick={() => run(async () => (await window.piAgent.approvePeerTask(t.id, folders[t.id]!), await refresh()))}
                  >
                    승인
                  </button>
                  <button className="small" onClick={() => run(async () => (await window.piAgent.rejectPeerTask(t.id), await refresh()))}>
                    거절
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.inbound.length > 0 && (
          <section className="card">
            <h3>들어온 페어링 요청</h3>
            <ul className="list">
              {state.inbound.map((r) => (
                <li key={r.requestId}>
                  <div className="grow">
                    <strong>{r.name}</strong> <span className="muted small-text">{r.address}</span>
                    <div className="muted small-text">{r.description}</div>
                  </div>
                  <button className="small primary" onClick={() => run(async () => (await window.piAgent.approvePairing(r.requestId), await refresh()))}>
                    승인
                  </button>
                  <button className="small" onClick={() => run(async () => (await window.piAgent.rejectPairing(r.requestId), await refresh()))}>
                    거절
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card">
          <h3>받기</h3>
          <label className="check-row">
            <input type="checkbox" checked={s.enabled} onChange={(e) => run(async () => (await window.piAgent.setNetworkSettings({ ...s, enabled: e.target.checked }), await refresh()))} />
            <span>다른 에이전트가 이 에이전트를 찾고 페어링·질문할 수 있게 하기 (기본 꺼짐)</span>
          </label>
          {s.enabled && (
            <>
              <div className="form-row">
                <span className="muted small-text">내 주소</span>
                <select
                  value={s.advertise ?? ""}
                  onChange={(e) => run(async () => (await window.piAgent.setNetworkSettings({ ...s, advertise: e.target.value }), await refresh()))}
                >
                  {[...new Set([s.advertise ?? "", ...state.lanAddresses])].filter(Boolean).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <span className={state.listening ? "badge" : "badge warn"}>{state.listening ? "받는 중" : "켜는 중… (30초 안에)"}</span>
              </div>
              <p className="muted small-text">
                상대에게 이 주소를 알려 주세요. 같은 네트워크(사내망·VPN)에서만 닿습니다. 처음 켜면 Windows 방화벽이 node의 연결 허용을 물을 수 있습니다. 포트 {s.port}
              </p>
            </>
          )}
        </section>

        <section className="card">
          <h3>내 에이전트 카드</h3>
          <p className="muted small-text">상대에게 보이는 소개입니다. 무엇을 잘하는지 적어 두면 상대 에이전트가 알맞은 질문을 보냅니다.</p>
          <div className="form-row">
            <input value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} placeholder="이름 (예: 준혁의 에이전트)" />
          </div>
          <div className="form-row">
            <input className="grow" value={card.description} onChange={(e) => setCard({ ...card, description: e.target.value })} placeholder="소개 (예: Java 레거시 현대화와 Electron 앱 개발)" />
          </div>
          <textarea
            className="network-skills"
            value={card.skills.map((k) => (k.description ? `${k.name}: ${k.description}` : k.name)).join("\n")}
            onChange={(e) =>
              setCard({
                ...card,
                skills: e.target.value.split("\n").map((line, i) => {
                  const [name, ...rest] = line.split(":");
                  return { id: card.skills[i]?.id ?? "", name: name ?? "", description: rest.join(":").trim() };
                }),
              })
            }
            placeholder={"잘하는 것 한 줄에 하나 (이름: 설명)\n예: 빌드 오류 진단: Maven·Gradle 빌드 실패 원인 찾기"}
          />
          {drafted && <p className="notice-line small-text">초안입니다. 다른 사람에게 보이는 글이니 확인하고 고친 뒤 저장하세요.</p>}
          <div className="row">
            <button
              className="small primary"
              onClick={() =>
                run(async () => {
                  await window.piAgent.saveCard(card);
                  setCard(undefined);
                  setDrafted(false);
                  await refresh();
                })
              }
            >
              카드 저장
            </button>
            <button
              className="small"
              disabled={drafting}
              title="기억(사실·교훈)과 대화 이름으로 소개·잘하는 것을 채웁니다. 선호 기억과 대화 내용은 쓰지 않습니다. 저장하기 전까지 공개되지 않습니다"
              onClick={() =>
                run(async () => {
                  setDrafting(true);
                  try {
                    const draft = await window.piAgent.suggestCard(card);
                    setCard({ ...card, ...draft });
                    setDrafted(true);
                  } finally {
                    setDrafting(false);
                  }
                })
              }
            >
              {drafting ? "만드는 중…" : "기억으로 초안 만들기"}
            </button>
          </div>
        </section>

        <section className="card">
          <h3>피어 추가</h3>
          <div className="form-row">
            <input className="grow" value={address} onChange={(e) => (setAddress(e.target.value), setPreview(undefined))} placeholder="상대 주소 (예: 192.168.0.20:7811)" />
            <button className="small" disabled={!address.trim() || busy} onClick={() => run(async () => setPreview(await window.piAgent.previewPeer(address)))}>
              카드 보기
            </button>
          </div>
          {preview && (
            <div className="network-preview">
              <strong>{preview.name}</strong>
              <div className="muted small-text">{preview.description}</div>
              {preview.skills.length > 0 && <div className="small-text">잘하는 것: {preview.skills.map((k) => k.name).join(", ")}</div>}
              <button
                className="small primary"
                disabled={busy || !s.enabled}
                title={s.enabled ? "" : "상대가 승인 결과를 돌려주려면 받기를 켜야 합니다"}
                onClick={() =>
                  run(async () => {
                    setBusy(true);
                    try {
                      await window.piAgent.pairWith(address);
                      setAddress("");
                      setPreview(undefined);
                      await refresh();
                    } finally {
                      setBusy(false);
                    }
                  })
                }
              >
                페어링 요청
              </button>
              {!s.enabled && <span className="muted small-text"> 먼저 위에서 받기를 켜세요</span>}
            </div>
          )}
          {state.outbound.length > 0 && (
            <ul className="list">
              {state.outbound.map((r) => (
                <li key={r.requestId}>
                  <span className="grow">
                    {r.name} <span className="muted small-text">{r.address}</span>
                  </span>
                  <span className={r.status === "rejected" ? "badge warn" : "badge"}>{r.status === "rejected" ? "거절됨" : "상대 승인 기다리는 중"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>피어</h3>
          {state.peers.length === 0 ? (
            <p className="muted">아직 연결된 에이전트가 없습니다. 연결하면 대화에서 "○○에게 물어봐", "○○에게 맡겨"라고 할 수 있습니다.</p>
          ) : (
            <ul className="list">
              {state.peers.map((p) => (
                <li key={p.id}>
                  <div className="grow">
                    <strong>{p.name}</strong> <span className="muted small-text">{p.address}</span>
                    {p.description && <div className="muted small-text">{p.description}</div>}
                    {p.skills.length > 0 && <div className="small-text">잘하는 것: {p.skills.join(", ")}</div>}
                  </div>
                  <label className="check-row" title="이 피어의 질문에 답할지">
                    <input
                      type="checkbox"
                      checked={p.policy.question === "auto"}
                      onChange={(e) => run(async () => (await window.piAgent.setPeerPolicy(p.id, { ...p.policy, question: e.target.checked ? "auto" : "deny" }), await refresh()))}
                    />
                    <span className="small-text">질문 받기</span>
                  </label>
                  <label className="check-row" title="이 피어가 맡기는 작업을 받을지 (받으면 승인해야 시작)">
                    <input
                      type="checkbox"
                      checked={p.policy.task !== "deny"}
                      onChange={(e) => run(async () => (await window.piAgent.setPeerPolicy(p.id, { ...p.policy, task: e.target.checked ? "ask" : "deny" }), await refresh()))}
                    />
                    <span className="small-text">작업 받기</span>
                  </label>
                  <label className="small-text" title="하루에 답할 질문 수">
                    하루{" "}
                    <input
                      type="number"
                      className="network-limit"
                      min={0}
                      value={p.policy.dailyLimit}
                      onChange={(e) => run(async () => (await window.piAgent.setPeerPolicy(p.id, { ...p.policy, dailyLimit: Number(e.target.value) }), await refresh()))}
                    />
                  </label>
                  <button className="small" onClick={() => run(async () => (await window.piAgent.forgetPeer(p.id), await refresh()))}>
                    끊기
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {state.log.length > 0 && (
          <section className="card">
            <h3>최근 받은 질문</h3>
            <ul className="list">
              {state.log.map((e, i) => (
                <li key={i}>
                  <span className="muted small-text">{new Date(e.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                  <strong>{e.peerName}</strong>
                  <span className="grow network-question" title={e.question}>
                    {e.question}
                  </span>
                  <span className={e.status === "answered" ? "badge" : "badge warn"}>{LOG_LABEL[e.status]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

const LOG_LABEL: Record<NetworkState["log"][number]["status"], string> = {
  answered: "답함",
  task: "작업 받음",
  denied: "받지 않음",
  limit: "하루 상한",
  loop: "너무 많이 거침",
  error: "실패",
};
