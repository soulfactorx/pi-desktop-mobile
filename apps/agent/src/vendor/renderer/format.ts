/** 토큰 수를 짧게 표시한다: 950 → "950", 12_300 → "12.3k", 1_500_000 → "1.5M" */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

/** 비용(USD)을 표시한다. 1센트 미만은 소수 넷째 자리까지 보여준다. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** 모델 선택 목록의 값. 프로바이더마다 같은 ID가 있을 수 있어 함께 묶는다. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

/** 사용률(%)을 표시한다. 10% 미만은 소수 한 자리까지 보여줘 큰 컨텍스트 창에서도 0%로 뭉개지지 않게 한다. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value > 0 && value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

/** 지난 시각을 짧게 표시한다: "방금", "5분 전", "3시간 전", "2일 전", 그보다 오래되면 날짜 */
export function formatRelative(time: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "방금";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 경로의 마지막 폴더 이름. Windows(\)와 POSIX(/) 구분자를 모두 처리한다. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * 세션을 HTML로 내보낼 위치: 세션 파일 옆에 확장자만 바꾼다.
 * Pi 기본값은 작업 폴더(사용자 저장소)라서 피하고, Pi는 없는 폴더를 만들지 않으므로 이미 있는 세션 폴더를 쓴다.
 * 세션 파일이 없으면 undefined (Pi 기본 위치).
 */
export function htmlExportPath(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  return /\.jsonl$/i.test(sessionFile) ? sessionFile.replace(/\.jsonl$/i, ".html") : `${sessionFile}.html`;
}

/** 메시지 시각: 오늘이면 "15:04", 올해면 "11/1 15:04", 그 밖에는 "2025-11-01 15:04" */
export function formatMessageTime(time: number, now: number = Date.now()): string {
  const date = new Date(time);
  const today = new Date(now);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return hm;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hm}`;
}

/** 응답 하나의 토큰 사용량을 짧게: "입력 1.2k · 캐시 5k · 출력 320 · $0.0021" (없는 항목은 뺀다) */
export function formatUsageLine(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}): string {
  const parts = [`입력 ${formatTokens(usage.input + usage.cacheWrite)}`];
  if (usage.cacheRead > 0) parts.push(`캐시 ${formatTokens(usage.cacheRead)}`);
  parts.push(`출력 ${formatTokens(usage.output)}`);
  if (usage.cost !== undefined && usage.cost > 0) parts.push(formatCost(usage.cost));
  return parts.join(" · ");
}
