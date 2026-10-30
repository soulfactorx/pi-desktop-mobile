import type { HighlighterCore } from "shiki/core";

/**
 * 코드 블록 하이라이트 (shiki).
 *
 * - WASM(oniguruma) 대신 JavaScript 정규식 엔진을 써서 CSP에 wasm-unsafe-eval을 열지 않는다.
 * - 언어 문법은 처음 쓰일 때만 불러온다 (Vite가 언어별 청크로 나눈다).
 * - 밝은/어두운 테마를 CSS 변수로 함께 내보내 시스템 테마에 따라 바뀌게 한다 (styles.css).
 */

type Loader = () => Promise<unknown>;

/** 자주 쓰는 언어만 등록한다. 목록에 없으면 하이라이트 없이 보여준다. */
const LANGUAGES: Record<string, Loader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  jsonc: "json",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  console: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  patch: "diff",
  "c++": "cpp",
};

/** 코드 블록 언어 표기를 등록된 이름으로 바꾼다. 지원하지 않으면 undefined. */
export function normalizeLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const lower = lang.toLowerCase();
  const name = ALIASES[lower] ?? lower;
  return name in LANGUAGES ? name : undefined;
}

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

/** 하이라이트된 HTML을 돌려준다. 지원하지 않는 언어면 undefined (호출자가 일반 텍스트로 보여준다). */
export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
  const name = normalizeLanguage(lang);
  if (!name) return undefined;
  const core = await getHighlighter();
  let loading = loaded.get(name);
  if (!loading) {
    loading = LANGUAGES[name]!().then((module) => core.loadLanguage((module as { default: never }).default));
    loaded.set(name, loading);
  }
  await loading;
  // shiki는 코드 내용을 이스케이프한 HTML을 만든다.
  return core.codeToHtml(code, {
    lang: name,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}
