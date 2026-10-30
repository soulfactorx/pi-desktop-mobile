import { readInbox } from "@pi-desktop/mate-kit";
import type { MatePaths } from "./paths";
import { addRequest, saveDuty, setInboxStatus } from "./store";
import type { Duty } from "./types";
import { execCommand, type Exec } from "./watchers";

/**
 * 한 번만 도는 임무를 만들어 바로 실행을 요청한다 ("Mate에게 맡기기", 휴대폰 지시).
 * 임무로 남겨 두므로 실행 기록·세션을 볼 수 있고 다시 돌릴 수 있다.
 * act는 git 저장소에서만 되므로, 고치기를 원해도 저장소가 아니면 제안 단계로 실행한다.
 */
export async function requestOneOff(
  paths: MatePaths,
  input: { idPrefix: string; name: string; cwd: string; prompt: string; wantAct: boolean },
  exec: Exec = execCommand,
  now = Date.now(),
): Promise<Duty> {
  let profile: Duty["profile"] = "propose";
  if (input.wantAct) {
    const repo = await exec("git", ["rev-parse", "--is-inside-work-tree"], input.cwd);
    if (repo.code === 0 && repo.stdout.trim() === "true") profile = "act";
  }
  const duty = await saveDuty(paths, {
    id: `${input.idPrefix}-${now.toString(36)}`,
    name: input.name.slice(0, 80),
    enabled: true,
    cwd: input.cwd,
    prompt: input.prompt,
    profile,
    trigger: { kind: "manual" },
    createdAt: now,
  });
  await addRequest(paths, duty.id, now);
  return duty;
}

/** 제안의 "맡길 일"을 그 폴더에서 실행한다 (git 저장소면 고치기). 제안은 확인함으로 둔다 */
export async function delegateInboxItem(paths: MatePaths, itemId: string, exec: Exec = execCommand): Promise<Duty> {
  const item = (await readInbox(paths.inbox)).find((i) => i.id === itemId);
  if (!item?.followUp) throw new Error("맡길 일이 없는 제안입니다");
  // 관찰자에게 맡길 일을 그것만으로 실행할 수 있게 쓰라고 했으므로 지시는 그대로 쓴다
  const duty = await requestOneOff(
    paths,
    { idPrefix: "delegated", name: `맡긴 일: ${item.title}`, cwd: item.followUp.cwd, prompt: item.followUp.prompt, wantAct: true },
    exec,
  );
  await setInboxStatus(paths, [item.id], "accepted");
  return duty;
}
