/**
 * 폴더 고르기 (설계 DESIGN-MATE-REMOTE.md §1). 로컬이면 OS 폴더 창, 원격이면 실행기로 그 호스트의 폴더를 훑는 창(FolderPicker).
 * 원격 창은 App이 띄운다: App이 setFolderPickOpener로 여는 함수를 걸어 둔다.
 */
type Opener = (resolve: (folder: string | undefined) => void) => void;
let opener: Opener | undefined;

export function setFolderPickOpener(next: Opener | undefined): void {
  opener = next;
}

export async function pickFolder(): Promise<string | undefined> {
  const host = await window.mate.currentHost();
  if (!host.remote) return window.mate.pickDirectory();
  return new Promise((resolve) => (opener ? opener(resolve) : resolve(undefined)));
}

/** 경로 조각 (위 폴더로 가는 단추용) */
export function pathTrail(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}
