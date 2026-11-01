import { useCallback, useEffect, useState } from "react";
import type { CurrentHost, Overview, PiSetupView, UpdateState } from "../shared/api";
import { FolderPicker } from "./FolderPicker";
import { setFolderPickOpener } from "./folder-pick";
import { PiSetupBanner } from "./PiSetup";
import { ActivityView } from "./ActivityView";
import { ChatView } from "./ChatView";
import { DutiesView } from "./DutiesView";
import { PhoneView } from "./PhoneView";
import { InboxPanel } from "./InboxPanel";
import { splitInbox, STATUS_LABELS } from "./mate-view";
import { RunsView } from "./RunsView";
import { UsageView } from "./UsageView";
import { SettingsView } from "./SettingsView";
import { TrashView } from "./TrashView";
import { SkillsMcpView } from "./SkillsMcpView";

type Tab = "chat" | "inbox" | "duties" | "activity" | "runs" | "usage" | "tools" | "trash" | "phone" | "settings";

/** 화면 전체. Mate 홈의 파일이 바뀔 때마다(실행기·확장이 쓴 것 포함) 다시 읽는다 */
export function App() {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [tab, setTab] = useState<Tab>("chat");
  const [now, setNow] = useState(Date.now());
  const [setup, setSetup] = useState<PiSetupView>();
  const [update, setUpdate] = useState<UpdateState>();
  /** 지금 호스트 (원격이면 머리에 보이고, 폴더는 그 호스트에서 고른다) */
  const [host, setHost] = useState<CurrentHost>();
  const [folderPick, setFolderPick] = useState<{ resolve: (folder: string | undefined) => void }>();
  useEffect(() => {
    setFolderPickOpener((resolve) => setFolderPick({ resolve }));
    return () => setFolderPickOpener(undefined);
  }, []);
  useEffect(() => {
    void window.mate.updateState().then(setUpdate);
    return window.mate.onUpdateState(setUpdate);
  }, []);
  const checkSetup = useCallback((refresh = false) => {
    void window.mate.piReadiness(refresh).then(setSetup);
  }, []);
  useEffect(() => checkSetup(), [checkSetup]);

  const refresh = useCallback(async () => {
    try {
      setOverview(await window.mate.overview());
      void window.mate.currentHost().then(setHost);
      // 실행기가 방금 쓴 시각이 화면의 "지금"보다 뒤로 보이지 않게 함께 갱신한다
      setNow(Date.now());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.mate.onChanged(() => void refresh());
    // 실행기 생존·남은 시간 표시를 위해 가끔 다시 읽는다
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 10_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh]);

  /**
   * 화면 동작 뒤 바로 다시 읽고, 실패하면 위에 보인다. 성공 여부를 돌려준다 (실패하면 폼을 닫지 않도록).
   * 동작 오류는 다시 읽기(refresh)가 지우지 않게 따로 두고, 다음 동작이 성공하면 지운다.
   */
  const act = useCallback(
    async (job: () => Promise<unknown>): Promise<boolean> => {
      let ok = true;
      try {
        await job();
        setActionError(undefined);
      } catch (e) {
        ok = false;
        setActionError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      }
      await refresh();
      return ok;
    },
    [refresh],
  );

  if (!overview) return <div className="loading">{error ?? "불러오는 중…"}</div>;
  const freshCount = splitInbox(overview.inbox).fresh.length;
  // 답하지 않은 Mate 질문 수 (대화 탭 배지)
  const answeredIds = new Set(overview.chat.lines.map((l) => l.answerTo).filter(Boolean));
  const openQuestions = overview.chat.lines.filter((l) => l.kind === "question" && !answeredIds.has(l.id)).length;
  const { runner } = overview;
  const current = runner.current ? overview.duties.find((d) => d.id === runner.current!.dutyId) : undefined;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">Pi Desktop Mate{host?.remote && <span className="count"> · {hostLabel(host.id)}</span>}</div>
        <nav className="tabs">
          <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
            대화{openQuestions > 0 && <span className="badge">{openQuestions}</span>}
            {overview.chat.busy && <span className="count"> …</span>}
          </button>
          <button className={tab === "inbox" ? "active" : ""} onClick={() => setTab("inbox")}>
            인박스{freshCount > 0 && <span className="badge">{freshCount}</span>}
          </button>
          <button className={tab === "duties" ? "active" : ""} onClick={() => setTab("duties")}>
            임무 <span className="count">{overview.duties.length}</span>
          </button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
            활동{overview.config.observe.enabled && <span className="count"> 관찰 중</span>}
          </button>
          <button className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>
            실행 기록
          </button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>
            사용량
          </button>
          <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>
            스킬·MCP
          </button>
          <button className={tab === "trash" ? "active" : ""} onClick={() => setTab("trash")}>
            휴지통{overview.trash.length > 0 && <span className="count"> {overview.trash.length}</span>}
          </button>
          <button className={tab === "phone" ? "active" : ""} onClick={() => setTab("phone")}>
            휴대폰{overview.config.telegram.enabled && overview.config.telegram.tokenEnc && <span className="count"> 연결</span>}
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            설정
          </button>
        </nav>
        <div className="runner-status" title={runner.pid ? `실행기 pid ${runner.pid}` : undefined}>
          {update && (update.status === "available" || update.status === "downloading" || update.status === "downloaded") && (
            <button className="small primary" onClick={() => void act(() => window.mate.confirmUpdate())} disabled={update.status === "downloading"}>
              {update.status === "downloading"
                ? `업데이트 받는 중 ${update.percent ?? 0}%`
                : update.status === "downloaded"
                  ? `${update.version} 설치하려면 다시 시작`
                  : `새 버전 ${update.version}`}
            </button>
          )}
          {overview.config.paused && <span className="chip warn">일시 정지</span>}
          {runner.alive ? (
            <span className="chip ok">{current ? `${current.name} ${STATUS_LABELS.running}` : "실행기 대기 중"}</span>
          ) : (
            <>
              <span className="chip bad">실행기 꺼짐</span>
              <button className="small" onClick={() => void act(() => window.mate.restartRunner())}>
                다시 시작
              </button>
            </>
          )}
        </div>
      </header>
      {(actionError ?? error ?? runner.error) && <div className="banner bad">{actionError ?? error ?? runner.error}</div>}
      {setup && (
        <PiSetupBanner
          setup={setup}
          model={overview.config.model}
          act={act}
          onRefresh={() => checkSetup(true)}
          onUsePiDefault={() => void act(() => window.mate.saveConfig({ model: setup.piDefaultModel! }))}
        />
      )}
      <main className="content">
        {tab === "chat" && <ChatView overview={overview} now={now} act={act} />}
        {tab === "inbox" && <InboxPanel overview={overview} now={now} act={act} />}
        {tab === "duties" && <DutiesView overview={overview} now={now} act={act} setup={setup} />}
        {tab === "activity" && <ActivityView overview={overview} now={now} act={act} />}
        {tab === "runs" && <RunsView overview={overview} now={now} act={act} />}
        {tab === "usage" && (
          <section className="usage-page">
            <p className="muted small-text">Mate 대화와 임무 실행이 쓴 토큰과 비용입니다 (Mate 홈의 Pi 세션).</p>
            <UsageView
              load={(range) => window.mate.usageSummary(range)}
              onError={(message) => void act(() => Promise.reject(new Error(message)))}
              sourceLabels={{ chat: "대화", schedule: "임무 실행" }}
            />
          </section>
        )}
        {tab === "tools" && <SkillsMcpView act={act} />}
        {tab === "trash" && <TrashView overview={overview} now={now} act={act} />}
        {tab === "phone" && (
          <section>
            <PhoneView overview={overview} act={act} {...(host?.remote ? { remoteHost: hostLabel(host.id) } : {})} />
          </section>
        )}
        {tab === "settings" && (
          <SettingsView overview={overview} act={act} setup={setup} onRefreshSetup={() => checkSetup(true)} update={update} />
        )}
      </main>
      {folderPick && host && (
        <FolderPicker
          hostLabel={hostLabel(host.id)}
          initial={host.userHome}
          onPick={(folder) => {
            folderPick.resolve(folder);
            setFolderPick(undefined);
          }}
          onClose={() => {
            folderPick.resolve(undefined);
            setFolderPick(undefined);
          }}
        />
      )}
    </div>
  );
}

/** 호스트 id를 사람이 읽는 이름으로 ("wsl:Ubuntu" → "WSL: Ubuntu") */
export function hostLabel(id: string): string {
  if (id === "local") return "로컬";
  if (id.startsWith("wsl:")) return `WSL: ${id.slice(4)}`;
  if (id.startsWith("ssh:")) return `SSH: ${id.slice(4)}`;
  return id;
}

export type Act = (job: () => Promise<unknown>) => Promise<boolean>;
