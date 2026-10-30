import { spawn } from "node:child_process";
import { APPROVAL_MARKER } from "../../src/approval";
import { UNATTENDED_ENV, WORKER_ENV } from "../../src/runtime";
import { recordUsage, type PiUsage } from "../../src/usage";
import { dataDir } from "../permissions/store";

/**
 * 워커 실행기 (설계 DESIGN-AGENT.md §4 "메인/워커 분리").
 *
 * 맡긴 일을 지금 Pi와 같은 설정(모델·agent-kit 확장·환경 변수)의 자식 `pi --mode rpc`로 돌린다.
 * 자식이 띄우는 확장 다이얼로그(승인 요청 포함)는 부모의 ctx.ui로 넘겨 사람이 답하게 한다.
 * UI를 넘기지 않으면 자식은 "사람이 없는 실행"이라 쓰기·실행이 거부된다 (예약 실행).
 */

/** 부모 쪽 UI. ExtensionUIContext의 다이얼로그 일부 */
export interface UiProxy {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface WorkerOptions {
  /** 다이얼로그·알림에 붙일 이름 (예: 작업 t1) */
  label: string;
  prompt: string;
  cwd: string;
  provider?: string;
  model?: string;
  ui?: UiProxy;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** 지금 Pi 프로세스의 실행 인자 (agent-kit 확장 -e를 물려준다). 기본은 process.argv */
  argv?: string[];
  /** pi에 더 줄 인자 (예: 피어 답변 워커의 --no-tools) */
  extraArgs?: string[];
  /** 사용량을 적을 때의 쓰임새. 기본 worker */
  usageSource?: "worker" | "peer";
}

export interface WorkerResult {
  /** 마지막 응답의 글 */
  text: string;
  aborted: boolean;
}

/** 지금 Pi를 다시 띄우는 명령. node로 cli.js를 돌리는 경우가 기본이고, 아니면 PATH의 pi */
export function piCommand(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (env.PI_DESKTOP_AGENT_PI_CLI) return { command: process.execPath, args: [env.PI_DESKTOP_AGENT_PI_CLI] };
  const script = argv[1];
  if (script && /\.(c|m)?js$/i.test(script)) return { command: process.execPath, args: [script] };
  return { command: "pi", args: [] };
}

/** 값을 하나 받는 옵션 중 물려줄 것 */
const INHERITED_WITH_VALUE = new Set(["-e", "--extension", "--skill", "--prompt-template"]);
/** 물려줄 끄기 옵션. 앱이 Pi 기본 폴더의 확장·스킬·프롬프트·문맥 파일을 끄고 띄웠으면 워커도 같아야 한다 (DESIGN-APPS.md §3.1) */
const INHERITED_FLAGS = new Set(["-ne", "--no-extensions", "-ns", "--no-skills", "-np", "--no-prompt-templates", "-nc", "--no-context-files"]);

/** 지금 Pi에 붙은 확장·스킬·프롬프트 경로와 끄기 옵션을 그대로 물려줄 인자. 세션 폴더는 물려주지 않는다 (워커는 세션을 남기지 않음) */
export function inheritedArgsOf(argv: string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (INHERITED_FLAGS.has(arg)) args.push(arg);
    else if (INHERITED_WITH_VALUE.has(arg) && i + 1 < argv.length) args.push(arg, argv[++i]!);
  }
  return args;
}

/** 자식의 승인 요청이 어느 작업에서 왔는지 보이게 한다. 승인 형식은 첫 줄 끝에 붙여 앱이 그대로 읽게 한다 */
export function labelTitle(title: string, label: string): string {
  if (!title.startsWith(APPROVAL_MARKER)) return `[${label}] ${title}`;
  const newline = title.indexOf("\n");
  return newline < 0 ? `${title} (${label})` : `${title.slice(0, newline)} (${label})${title.slice(newline)}`;
}

export function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const argv = options.argv ?? process.argv;
  const pi = piCommand(argv, options.env ?? process.env);
  const args = [
    ...pi.args,
    "--mode",
    "rpc",
    "--no-session",
    ...(options.provider && options.model ? ["--provider", options.provider, "--model", options.model] : []),
    ...inheritedArgsOf(argv),
    ...(options.extraArgs ?? []),
  ];
  const env = { ...(options.env ?? process.env), [WORKER_ENV]: "1", ...(options.ui ? {} : { [UNATTENDED_ENV]: "1" }) };
  const child = spawn(pi.command, args, { cwd: options.cwd, env, shell: pi.command === "pi" && process.platform === "win32", windowsHide: true });

  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    let lastText = "";
    /** 마지막 응답이 모델 오류로 끝났으면 그 내용. 글 없이 오류로 끝난 실행은 실패로 본다 */
    let lastError: string | undefined;
    let settled = false;
    let aborted = false;
    const write = (record: Record<string, unknown>) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(record)}\n`);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
      if (error) reject(error);
      else if (!lastText && lastError && !aborted) reject(new Error(`모델 호출이 실패했다: ${lastError}`));
      else resolve({ text: lastText, aborted });
    };
    const onAbort = () => {
      aborted = true;
      write({ type: "abort" });
      setTimeout(() => finish(), 3000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const answer = async (request: Record<string, unknown>) => {
      const id = request.id;
      const ui = options.ui;
      const title = labelTitle(String(request.title ?? ""), options.label);
      try {
        switch (request.method) {
          case "select": {
            const value = ui ? await ui.select(title, (request.options as string[]) ?? []) : undefined;
            write(value === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value });
            return;
          }
          case "confirm": {
            const confirmed = ui ? await ui.confirm(title, String(request.message ?? "")) : false;
            write({ type: "extension_ui_response", id, confirmed });
            return;
          }
          case "input":
          case "editor": {
            const value = ui
              ? request.method === "input"
                ? await ui.input(title, request.placeholder as string | undefined)
                : await ui.editor(title, request.prefill as string | undefined)
              : undefined;
            write(value === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value });
            return;
          }
          case "notify":
            ui?.notify(`[${options.label}] ${String(request.message ?? "")}`, (request.notifyType as "info" | "warning" | "error") ?? "info");
            return;
          default:
            // setStatus·setWidget 같은 화면 꾸미기는 워커에서 넘기지 않는다
            return;
        }
      } catch {
        write({ type: "extension_ui_response", id, cancelled: true });
      }
    };

    const receive = (record: Record<string, unknown>) => {
      if (record.type === "extension_ui_request") void answer(record);
      else if (record.type === "message_end") {
        const message = record.message as
          | {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
              stopReason?: string;
              errorMessage?: string;
              provider?: string;
              model?: string;
              usage?: PiUsage;
            }
          | undefined;
        // 워커는 --no-session이라 세션 파일에 남지 않는다. 응답마다 사용량을 따로 적는다
        if (message?.role === "assistant" && message.usage)
          void recordUsage(dataDir(env), options.usageSource ?? "worker", { provider: message.provider ?? "?", id: message.model ?? "?" }, message.usage);
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const text = message.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
          if (text) {
            lastText = text;
            lastError = undefined;
          } else if (message.stopReason === "error") {
            lastError = message.errorMessage ?? "알 수 없는 오류";
          }
        }
      } else if (record.type === "agent_settled") finish();
      else if (record.type === "response" && record.id === "worker-prompt" && record.success === false) {
        finish(new Error(String(record.error ?? "워커가 요청을 받지 않았다")));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          receive(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // RPC가 아닌 줄은 무시한다
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(aborted ? undefined : new Error(`워커가 끝났다 (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });

    write({ type: "prompt", id: "worker-prompt", message: options.prompt });
  });
}
