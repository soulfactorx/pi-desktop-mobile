import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { approvalOptions, decisionOf, formatApprovalTitle } from "../../src/approval";
import { attended, confinedTo } from "../../src/runtime";
import { classify, confinementViolation, evaluate, hardBlockReason, insideRoot, type Rule } from "./rules";
import { addRule, appendAudit, dataDir, loadRules, type AuditRecord } from "./store";

/**
 * 승인 게이트 (설계 DESIGN-AGENT.md §4).
 *
 * 쓰기·실행 도구는 `tool_call`에서 멈추고 사람에게 묻는다. 순서:
 * 위험 명령 차단 → 저장된 거부·허용 규칙 → 이 세션 허용 → 사람이 없으면 거부 → `ctx.ui.select`로 묻기.
 * 거부·취소·시간 초과는 모두 거부다. 판단은 감사 로그에 남긴다.
 *
 * Pi 기본 동작(묻지 않음)과 다른 이 앱만의 선택이다. 확장 hook은 보안 경계가 아니므로, 이것은 동의 절차다.
 */
export default function permissions(pi: ExtensionAPI): void {
  const dir = dataDir();
  /** 이 세션에서 계속 허용한 것. 세션이 바뀌면 비운다 */
  let sessionRules: Rule[] = [];
  /**
   * 이번 실행(run)에서 사용자가 거부한 호출 (도구 + 대상).
   * 거부당한 도구를 같은 대상으로 또 부르는 것은 가장 분명한 제자리 돌기다 — desktop-agent에서
   * "다시 시도하지 말라"고 돌려줬는데도 모델이 네 번을 되풀이한 턴이 있었다. 같은 것은 다시 묻지 않고 거부한다.
   */
  const deniedThisRun = new Set<string>();

  pi.on("session_start", async () => {
    sessionRules = [];
  });

  pi.on("agent_start", async () => {
    deniedThisRun.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    // 피어가 맡긴 작업: 승인된 폴더 밖은 읽기도 막는다 (읽은 것이 상대에게 돌아가므로)
    const root = confinedTo();
    if (root) {
      const violation = confinementViolation(event.toolName, input, ctx.cwd, root);
      if (violation) {
        await appendAudit(dir, { at: new Date().toISOString(), toolName: event.toolName, target: JSON.stringify(input).slice(0, 300), decision: "blocked", cwd: ctx.cwd });
        return { block: true, reason: `${violation}. 폴더 안에서 할 수 있는 일만 하고, 못 한 것은 결과에 적어라.` };
      }
    }
    const { request, invalid } = classify(event.toolName, input);
    if (!request) return undefined;

    const audit = (decision: AuditRecord["decision"]) =>
      appendAudit(dir, { at: new Date().toISOString(), toolName: request.toolName, target: request.target, decision, cwd: ctx.cwd });
    const deny = async (decision: AuditRecord["decision"], reason: string) => {
      await audit(decision);
      return { block: true, reason };
    };

    if (request.risk === "exec") {
      const blocked = hardBlockReason(request.target);
      if (blocked) return deny("blocked", `${blocked}. 같은 명령을 다시 시도하지 말라.`);
    }

    // 권한 상승: 잘못된 입력은 묻지 않고 막고, 저장된 규칙·세션 허용을 보지 않고 매번 한 번만 묻는다
    if (invalid) return deny("blocked", `잘못된 요청이라 실행하지 않았다: ${invalid}`);
    if (request.onceOnly) {
      if (!attended(ctx.hasUI)) return deny("unattended", "사람이 확인할 수 없는 실행이라 관리자 권한 실행을 쓸 수 없다.");
      const choice = decisionOf(await ctx.ui.select(formatApprovalTitle(request), approvalOptions(request)));
      if (choice !== "once") return deny("deny", "사용자가 거부했다. 같은 작업을 다시 요청하지 말고 사용자에게 이유를 물어라.");
      await audit("once");
      return undefined;
    }

    const saved = evaluate(await loadRules(dir), request.toolName, request.target);
    if (saved === "deny") return deny("deny-rule", "사용자가 저장한 거부 규칙에 걸렸다. 다른 방법을 찾거나 사용자에게 물어라.");
    if (saved === "allow") {
      await audit("allow-rule");
      return undefined;
    }
    if (evaluate(sessionRules, request.toolName, request.target) === "allow") {
      await audit("session-rule");
      return undefined;
    }

    // 피어 작업은 사람이 폴더를 골라 승인했으므로 그 안의 쓰기는 묻지 않고 허용한다 (실행·네트워크는 아래에서 거부)
    if (root && request.risk === "write" && insideRoot(request.target, root)) {
      await audit("peer-folder");
      return undefined;
    }
    // 예약 실행·피어 요청처럼 사람이 지켜보지 않는 실행에서는 묻지 못하므로 거부한다 (설계 §1).
    if (!attended(ctx.hasUI)) return deny("unattended", "사람이 확인할 수 없는 실행이라 쓰기·실행 도구를 쓸 수 없다.");

    const key = `${request.toolName}\n${request.target}`;
    if (deniedThisRun.has(key)) {
      return deny("repeat-deny", "방금 사용자가 거부한 것과 똑같은 호출이라 다시 묻지 않고 거부했다. 다른 방법을 찾거나 사용자에게 이유를 물어라.");
    }

    const decision = decisionOf(await ctx.ui.select(formatApprovalTitle(request), approvalOptions(request)));
    if (decision === "deny") {
      deniedThisRun.add(key);
      return deny("deny", "사용자가 거부했다. 같은 작업을 다시 시도하지 말고, 다른 방법을 찾거나 사용자에게 이유를 물어라.");
    }
    if (decision === "session") sessionRules.push({ toolName: request.toolName, pattern: request.pattern, action: "allow" });
    if (decision === "always") await addRule(dir, { toolName: request.toolName, pattern: request.pattern, action: "allow" });
    await audit(decision);
    return undefined;
  });
}
