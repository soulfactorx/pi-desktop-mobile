import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/*
 * 입력창 높이 (Pi Desktop·Agent·Mate가 같은 파일을 복사해 쓴다).
 * - 글이 늘면 저절로 높아진다 (화면 높이의 45%까지, 그 뒤로는 입력창 안에서 스크롤)
 * - 입력창 위 손잡이를 끌면 높이를 직접 정한다 (마우스·터치). 정한 높이는 기억하고, 글이 더 많으면 그보다 더 늘어난다
 * - 손잡이를 두 번 누르면 직접 정한 높이를 지우고 자동으로 돌아간다
 */

const AUTO_MAX = 0.45;
const MANUAL_MAX = 0.75;
const MIN_HEIGHT = 40;

function loadHeight(key: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveHeight(key: string, value: number | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // 저장할 수 없으면 이번만 쓴다
  }
}

/**
 * @param value 입력창의 글 (바뀔 때마다 높이를 다시 맞춘다)
 * @param storageKey 직접 정한 높이를 기억할 이름 (앱마다)
 */
export function useComposerSize(textarea: RefObject<HTMLTextAreaElement | null>, value: string, storageKey: string) {
  const manual = useRef<number | undefined>(loadHeight(storageKey));

  const fit = useCallback(() => {
    const el = textarea.current;
    if (!el) return;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const autoMax = Math.max(MIN_HEIGHT * 2, Math.round(viewport * AUTO_MAX));
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = "auto";
    const natural = el.scrollHeight + border;
    const base = manual.current ?? 0;
    el.style.height = `${Math.max(base, Math.min(natural, autoMax))}px`;
  }, [textarea]);

  useLayoutEffect(fit, [value, fit]);

  useEffect(() => {
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    // 처음 그린 뒤 화면 CSS·글꼴이 늦게 적용되면 줄 높이가 달라지므로 크기가 바뀔 때마다 다시 맞춘다.
    // 같은 글이면 맞춘 높이도 같아 다시 알림이 오지 않는다 (되풀이되지 않음)
    let frame = 0;
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(fit);
          });
    if (textarea.current) observer?.observe(textarea.current);
    return () => {
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fit, textarea]);

  /** 손잡이를 위로 끌면 높아지고 아래로 끌면 낮아진다 */
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const el = textarea.current;
      if (!el || e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = el.offsetHeight;
      const max = Math.round((window.visualViewport?.height ?? window.innerHeight) * MANUAL_MAX);
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const next = Math.min(max, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY)));
        manual.current = next;
        el.style.height = `${next}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        saveHeight(storageKey, manual.current);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [textarea, storageKey],
  );

  const onDoubleClick = useCallback(() => {
    manual.current = undefined;
    saveHeight(storageKey, undefined);
    fit();
  }, [storageKey, fit]);

  return { fit, gripProps: { onPointerDown, onDoubleClick } };
}

/** 입력창 위의 손잡이 (끌어서 높이 조절, 두 번 누르면 자동) */
export function ComposerGrip(props: { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void; onDoubleClick: () => void }) {
  return (
    <div
      className="composer-grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label="입력창 높이 조절"
      title="끌어서 입력창 높이 조절 · 두 번 누르면 자동"
      {...props}
    />
  );
}
