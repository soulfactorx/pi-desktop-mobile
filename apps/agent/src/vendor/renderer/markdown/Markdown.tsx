import { memo, useEffect, useState, type ComponentProps, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "./highlighter";

/**
 * 응답 본문 마크다운 렌더링 (GFM: 표, 체크리스트, 취소선, 자동 링크).
 *
 * - 원문 HTML은 렌더링하지 않는다 (react-markdown 기본값). 모델 출력에 섞인 태그가 실행되지 않게 한다.
 * - 링크는 새 창 요청으로 만들고, main 프로세스가 외부 브라우저로 연다 (앱 창이 이동하지 않게).
 * - 스트리밍 중에는 같은 텍스트로 다시 그리지 않도록 memo한다.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  // 블록 코드는 <pre><code class="language-xx">로 들어온다. pre를 통째로 코드 블록 컴포넌트로 바꾼다.
  pre: ({ children }) => {
    const code = children as ReactElement<ComponentProps<"code">> | undefined;
    const className = code?.props?.className ?? "";
    const lang = /language-([\w+#-]+)/.exec(className)?.[1];
    const raw = String(code?.props?.children ?? "").replace(/\n$/, "");
    return <CodeBlock code={raw} lang={lang} />;
  },
};

function CodeBlock({ code, lang }: { code: string; lang: string | undefined }) {
  const [html, setHtml] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 하이라이트는 비동기라 먼저 일반 텍스트로 보여주고, 끝나면 바꿔 끼운다.
    highlight(code, lang).then(
      (result) => !cancelled && setHtml(result),
      () => !cancelled && setHtml(undefined),
    );
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 권한이 없으면 조용히 무시한다.
    }
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? "text"}</span>
        <button type="button" className="code-copy" onClick={() => void copy()}>
          {copied ? "복사됨" : "복사"}
        </button>
      </div>
      {html ? (
        <div className="code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
