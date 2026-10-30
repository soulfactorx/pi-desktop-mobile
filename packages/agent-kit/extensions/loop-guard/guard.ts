/**
 * 한 실행(run) 안의 "제자리 돌기" 신호를 센다. 파일·Pi에 손대지 않는 순수 로직이다.
 *
 * desktop-agent에서 실제로 본 일들이다 (설계 DESIGN-AGENT.md §4 "반복·제자리 돌기 차단").
 * - 같은 디렉터리 목록을 두 번 받고, 거기 답이 있는데도 없는 경로를 두 번 더 찾았다.
 * - 같은 문단을 되풀이하다 사용자가 손으로 멈춰야 했다.
 * 작은 모델은 "조사 결과를 누적하라"는 프롬프트 규칙을 따르지 않으므로 코드로 막는다.
 */

/** 이만큼 신호가 쌓이면 실행을 멈춘다 */
export const SPIN_LIMIT = 3;

/** 이보다 짧은 문단은 반복으로 세지 않는다 ("확인했습니다." 같은 말은 자연스럽게 되풀이된다) */
const MIN_PARAGRAPH = 30;

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export class RunGuard {
  /** 이번 실행에서 성공한 조회. 쓰기·실행이 성공하면 바깥이 바뀌었을 수 있어 비운다 */
  private readonly reads = new Set<string>();
  private readonly paragraphs = new Set<string>();
  private signals = 0;

  reset(): void {
    this.reads.clear();
    this.paragraphs.clear();
    this.signals = 0;
  }

  get spins(): number {
    return this.signals;
  }

  get stopped(): boolean {
    return this.signals >= SPIN_LIMIT;
  }

  /** 막아야 할 호출이면 모델에 돌려줄 이유, 아니면 undefined */
  checkCall(toolName: string, input: Record<string, unknown>): string | undefined {
    if (!READ_TOOLS.has(toolName) || !this.reads.has(callKey(toolName, input))) return undefined;
    this.signals++;
    return "이번 작업에서 이미 똑같은 조회를 했고 결과를 받았다. 같은 것을 또 부르지 말고, 앞서 받은 결과를 근거로 다음 단계로 넘어가라.";
  }

  recordResult(toolName: string, input: Record<string, unknown>, isError: boolean): void {
    if (isError) return;
    if (READ_TOOLS.has(toolName)) this.reads.add(callKey(toolName, input));
    else this.reads.clear();
  }

  /** 모델이 쓴 글. 이번 실행에서 이미 쓴 문단이 다시 나오면 신호로 센다 */
  recordText(text: string): void {
    for (const paragraph of text.split(/\n\s*\n/)) {
      const key = paragraph.replace(/\s+/g, " ").trim().toLowerCase();
      if (key.length < MIN_PARAGRAPH) continue;
      if (this.paragraphs.has(key)) this.signals++;
      else this.paragraphs.add(key);
    }
  }
}

/** 키 순서가 흔들려도 같은 호출로 보이도록 정렬한다 (Pi 기본 읽기 도구의 입력은 평평한 객체다) */
export function callKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName} ${JSON.stringify(input, Object.keys(input).sort())}`;
}
