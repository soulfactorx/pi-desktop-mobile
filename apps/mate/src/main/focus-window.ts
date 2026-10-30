import { execFile } from "node:child_process";

/**
 * 이미 떠 있는 앱의 창을 앞으로 가져온다 (Pi Desktop 열기, 설계 DESIGN-MATE.md §9).
 *
 * Pi Desktop은 단일 인스턴스 처리가 없어, 실행 파일을 다시 열면 두 번째 창이 뜬다.
 * 그래서 열기 전에 떠 있는 창을 찾아 포커스를 옮긴다. 찾았으면 true.
 * - Windows: 프로세스 이름이 정확히 같은(예: "Pi Desktop" — Mate·Agent 제외) 프로세스 중 창이 있는 것을
 *   최소화되어 있으면 복원하고 앞으로 가져온다. 다른 프로세스가 포커스를 가져가는 것을 Windows가 막을 수 있어
 *   Alt 키 입력을 흉내 낸 뒤 SetForegroundWindow를 부른다(널리 쓰는 우회).
 * - Linux: wmctrl이 있으면 창 클래스로 앞으로 가져온다
 * - macOS: .app을 여는 것만으로 떠 있는 앱으로 포커스가 옮겨지므로 여기서는 하지 않는다
 */
export function focusRunningApp(processName: string, linuxWmClass: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === "win32") return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(focusScript(processName))]);
  if (platform === "linux") return run("wmctrl", ["-x", "-a", linuxWmClass]);
  return Promise.resolve(false);
}

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error) => resolve(!error));
  });
}

/** PowerShell -EncodedCommand 형식(UTF-16LE base64) */
function encode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** 창을 찾아 앞으로 가져오는 PowerShell. 찾지 못하면 종료 코드 2 */
export function focusScript(processName: string): string {
  const name = processName.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { exit 2 }
Add-Type -Namespace MateFocus -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
$h = $p.MainWindowHandle
if ([MateFocus.Win32]::IsIconic($h)) { [void][MateFocus.Win32]::ShowWindowAsync($h, 9) }
[MateFocus.Win32]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
[MateFocus.Win32]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
if (-not [MateFocus.Win32]::SetForegroundWindow($h)) { exit 3 }
exit 0
`;
}
