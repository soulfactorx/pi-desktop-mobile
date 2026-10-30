import { parseApprovalTitle } from "@pi-desktop/agent-kit/approval";
import { ExtensionDialog } from "../vendor/renderer/ExtensionUi";
import type { DialogRequest } from "../vendor/renderer/extension-ui-state";
import { ApprovalDialog } from "./ApprovalDialog";

type Answer = { value?: string; confirmed?: boolean; cancelled?: boolean };

/** 확장 다이얼로그 하나를 띄운다. permissions 확장의 승인 요청이면 승인 화면으로, 아니면 일반 다이얼로그로 */
export function DialogHost({ dialog, onAnswer }: { dialog: DialogRequest; onAnswer: (answer: Answer) => void }) {
  const approval = dialog.method === "select" ? parseApprovalTitle(dialog.title) : undefined;
  if (approval) return <ApprovalDialog dialog={dialog} approval={approval} onAnswer={onAnswer} />;
  return <ExtensionDialog dialog={dialog} onAnswer={onAnswer} />;
}
