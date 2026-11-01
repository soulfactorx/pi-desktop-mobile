/**
 * 웹앱의 버전을 첫 화면(이름 옆)에 작게 보인다. 업데이트가 됐는지 한눈에 보게.
 * 버전은 서버가 토큰 확인(/auth) 응답에 담아 준다 (릴리스 태그와 같다).
 * 앱 화면(React)이 그 자리를 다시 그리면 다시 붙인다.
 */
export function showVersion(version: string | undefined, target: string): void {
  if (!version) return;
  const text = `v${version.replace(/^v/, "")}`;
  const attach = () => {
    for (const el of document.querySelectorAll<HTMLElement>(target)) {
      if (el.querySelector(":scope > .ws-version")) continue;
      const tag = document.createElement("span");
      tag.className = "ws-version";
      tag.textContent = text;
      tag.title = `웹앱 버전 ${text}`;
      el.append(tag);
    }
  };
  attach();
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
}
