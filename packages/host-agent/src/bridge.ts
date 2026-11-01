import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi-desktop-bridge 확장 (설계 §5.3).
 *
 * Pi RPC에는 리소스를 다시 불러오는 명령이 없고, 확장 명령 안의 ctx.reload()로만 할 수 있다.
 * 그래서 데몬이 Pi를 띄울 때 이 작은 확장을 `-e`로 넣는다. 사용자 설정에는 기록하지 않는다.
 * 앱은 리소스를 저장한 뒤 `/desktop:reload`를 prompt로 보내 실행 중인 세션에 반영한다.
 *
 * 확장은 그 호스트의 Pi가 jiti로 불러오므로, Pi가 넣어 주는 패키지 말고는 import하지 않는 TypeScript 한 파일로 둔다.
 *
 * Windows 한글 출력: Pi는 bash 출력을 UTF-8로 읽는데, 한국어 Windows의 기본 명령(findstr·tasklist 등)은
 * CP949로 출력해 글자가 깨진다. 사용자가 shellCommandPrefix를 정하지 않았으면 bash 명령마다 앞에
 * `chcp.com 65001`을 붙인다. 명령마다 새 콘솔에서 돌아 한 번만 바꿔서는 안 된다.
 * - 모델의 bash 툴: tool_call에서 입력 명령을 바꾼다
 * - 입력창의 !명령(RPC bash): user_bash에서 같은 일을 하는 실행기를 넘긴다 (기록되는 명령은 원래 것)
 */

/** 앱이 보내는 명령 이름 (/desktop:reload) */
export const RELOAD_COMMAND = "desktop:reload";

/**
 * 확장 툴 켜기 명령 (/desktop:enable-tools).
 * 이어 연 세션은 기록된 툴 목록을 지키므로, 나중에 설치한 확장의 툴은 Pi를 다시 띄우거나 다시 불러와도 꺼진 채로 있다.
 * 앱은 다시 불러온 뒤 이 명령으로 켜져 있지 않은 확장 툴(내장 툴 제외)을 켠다. 켠 툴은 세션 기록에 남는다.
 */
export const ENABLE_TOOLS_COMMAND = "desktop:enable-tools";

/**
 * 트리 이동 명령 (/desktop:tree {"target":"<항목 id>","summarize":true,"instructions":"…"}).
 * TUI의 /tree와 같다: 같은 세션 파일 안에서 고른 항목으로 옮긴다. 떠나는 갈래는 요약을 붙일 수 있다
 * (요약 없이 / 요약 / 지시를 주고 요약). 사용자 메시지를 고르면 그 글을 입력창에 채운다.
 */
export const TREE_COMMAND = "desktop:tree";

/** Windows bash 명령 앞에 붙여 콘솔 출력을 UTF-8로 바꾸는 줄. 실행에만 붙고, 대화에 남는 명령(툴 인자·!명령)은 원래 것이다 */
export const UTF8_PREFIX = "chcp.com 65001 > /dev/null 2>&1";

export const BRIDGE_SOURCE = `// Pi Desktop이 Pi를 띄울 때 -e로 넣는 확장입니다. 직접 고치지 마세요 (앱이 다시 씁니다).
const UTF8_PREFIX = ${JSON.stringify(UTF8_PREFIX)};

export default function (pi: any) {
  // Windows에서 사용자가 shellCommandPrefix를 정하지 않았으면 bash 출력을 UTF-8로 받는다 (한글 깨짐 방지).
  const useUtf8 = () => process.platform === "win32" && !pi.getSettings?.()?.shellCommandPrefix;

  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "bash" || !useUtf8()) return undefined;
    const command = String(event.input?.command ?? "");
    if (!command.startsWith(UTF8_PREFIX)) event.input.command = UTF8_PREFIX + "\\n" + command;
    return undefined;
  });

  pi.on("user_bash", async () => {
    if (!useUtf8()) return undefined;
    const sdk: any = await import("@earendil-works/pi-coding-agent").catch(() => undefined);
    if (!sdk?.createLocalBashOperations) return undefined;
    const local = sdk.createLocalBashOperations({ shellPath: pi.getSettings?.()?.shellPath });
    return {
      operations: { exec: (command: string, cwd: string, options: any) => local.exec(UTF8_PREFIX + "\\n" + command, cwd, options) },
    };
  });

  pi.registerCommand("${RELOAD_COMMAND}", {
    description: "Pi Desktop: AGENTS.md·프롬프트·스킬·확장을 다시 불러옵니다",
    handler: async (_args: string, ctx: any) => {
      // 응답 중에 바꾸면 그 턴의 지침이 섞이므로, 끝난 뒤에만 다시 불러온다.
      if (!ctx.isIdle()) {
        ctx.ui.notify("작업 중에는 리소스를 다시 불러올 수 없습니다. 끝난 뒤 다시 시도하세요", "warning");
        return;
      }
      // reload 뒤에는 예전 확장 런타임의 ctx를 쓰면 안 되므로 여기서 끝낸다.
      await ctx.reload();
    },
  });

  pi.registerCommand("${TREE_COMMAND}", {
    description: "Pi Desktop: 세션 트리의 다른 위치로 옮깁니다 (떠나는 갈래 요약 선택)",
    handler: async (args: string, ctx: any) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("작업 중에는 옮길 수 없습니다. 끝난 뒤 다시 시도하세요", "warning");
        return;
      }
      let input: any;
      try {
        input = JSON.parse(String(args ?? ""));
      } catch {
        ctx.ui.notify("옮길 위치를 읽지 못했습니다", "error");
        return;
      }
      const target = String(input?.target ?? "");
      if (!target) return;
      // 사용자 메시지를 고르면 그 질문을 입력창에 채운다 (TUI와 같음)
      const entry = ctx.sessionManager?.getEntry?.(target);
      const content = entry?.type === "message" && entry.message?.role === "user" ? entry.message.content : undefined;
      const userText = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\\n") : undefined;
      const instructions = typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim() : undefined;
      const result = await ctx.navigateTree(target, {
        summarize: input.summarize === true || Boolean(instructions),
        ...(instructions ? { customInstructions: instructions } : {}),
      });
      if (result?.cancelled || result?.aborted) {
        ctx.ui.notify("옮기지 않았습니다", "info");
        return;
      }
      const editorText = typeof result?.editorText === "string" ? result.editorText : userText;
      if (editorText) ctx.ui.setEditorText(editorText);
    },
  });

  pi.registerCommand("${ENABLE_TOOLS_COMMAND}", {
    description: "Pi Desktop: 설치한 확장의 툴 중 꺼져 있는 것을 이 세션에서 켭니다",
    handler: async (_args: string, ctx: any) => {
      if (!pi.getAllTools || !pi.getActiveTools || !pi.setActiveTools) return;
      if (!ctx.isIdle()) {
        ctx.ui.notify("작업 중에는 툴을 바꿀 수 없습니다. 끝난 뒤 다시 시도하세요", "warning");
        return;
      }
      const active = new Set((pi.getActiveTools() as any[]).map((t: any) => (typeof t === "string" ? t : t.name)));
      const added = (pi.getAllTools() as any[])
        .filter((t: any) => t.sourceInfo?.source !== "builtin" && !active.has(t.name))
        .map((t: any) => t.name);
      if (added.length === 0) return;
      pi.setActiveTools([...active, ...added]);
      ctx.ui.notify("확장 툴을 켰습니다: " + added.join(", "), "info");
    },
  });
}
`;

/** 내용 해시를 이름에 넣은 bridge 파일을 dir에 두고 그 경로를 돌려준다. 같은 내용이면 다시 쓰지 않는다 */
export async function ensureBridge(dir: string): Promise<string> {
  const hash = createHash("sha256").update(BRIDGE_SOURCE).digest("hex").slice(0, 12);
  const path = join(dir, `pi-desktop-bridge-${hash}.ts`);
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, BRIDGE_SOURCE, "utf8");
  await rename(tmp, path);
  return path;
}

/**
 * 확장 관리 툴 (resources_list·resource_save·mcp_server·pi_package 등, DESIGN-APPS.md §3.5 3단계).
 * 소스는 packages/pi-resources/extensions/manage.ts 하나이고, 번들할 때 문자열로 넣는다 (데몬은 파일 하나만 싣는다).
 * 개발·시험에서는 번들 전이라 워크스페이스의 파일을 읽는다.
 */
declare const __MANAGE_EXTENSION_SOURCE__: string | undefined;

export function manageSource(): string {
  if (typeof __MANAGE_EXTENSION_SOURCE__ === "string") return __MANAGE_EXTENSION_SOURCE__;
  return readFileSync(fileURLToPath(new URL("../../pi-resources/extensions/manage.ts", import.meta.url)), "utf8");
}

/** 내용 해시를 이름에 넣은 관리 확장 파일을 dir에 두고 그 경로를 돌려준다 */
export async function ensureManage(dir: string): Promise<string> {
  const source = manageSource();
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const path = join(dir, `pi-desktop-manage-${hash}.ts`);
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, source, "utf8");
  await rename(tmp, path);
  return path;
}
