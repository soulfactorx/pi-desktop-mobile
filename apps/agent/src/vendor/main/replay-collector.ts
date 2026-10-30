/**
 * attach 중에 도착한 세션 이벤트를 모아 attach 결과와 함께 돌려주기 위한 버퍼.
 *
 * 데몬은 재생 이벤트를 attach 응답보다 먼저 보낸다. main은 그 순서대로 받지만,
 * 이벤트를 webContents.send로, 응답을 invoke 회신으로 넘기면 렌더러에는 응답이 먼저 도착할 수 있다
 * (실제로 발생: 대기 목록으로 거른 뒤에 이미 답한 다이얼로그가 재생되어 다시 뜸).
 * 그래서 attach가 진행되는 동안 그 세션의 이벤트를 모아 결과에도 담는다.
 * 알림으로도 그대로 보낸다: 같은 세션을 이미 보고 있는 다른 탭이 이벤트를 놓치면 안 되기 때문이다.
 * attach하는 쪽(렌더러)은 결과를 먼저 적용하고, attach 중에 알림으로 온 것은 모아 두었다가 순번으로 중복을 거른다.
 *
 * 같은 세션에 attach가 겹칠 수 있으므로(개발 모드의 React StrictMode 등) 요청마다 버퍼를 따로 둔다.
 */
export class ReplayCollector<T> {
  private readonly active = new Map<string, Set<T[]>>();

  /** attach를 시작한다. 돌려받은 버퍼에 이벤트가 쌓인다. */
  begin(key: string): T[] {
    const buffer: T[] = [];
    let set = this.active.get(key);
    if (!set) {
      set = new Set();
      this.active.set(key, set);
    }
    set.add(buffer);
    return buffer;
  }

  /** attach가 끝났다. 이후 이벤트는 평소처럼 알림으로 보낸다. */
  end(key: string, buffer: T[]): void {
    const set = this.active.get(key);
    if (!set) return;
    set.delete(buffer);
    if (set.size === 0) this.active.delete(key);
  }

  /** 진행 중인 attach가 있으면 이벤트를 모으고 true. 없으면 false. */
  capture(key: string, item: T): boolean {
    const set = this.active.get(key);
    if (!set) return false;
    for (const buffer of set) buffer.push(item);
    return true;
  }
}
