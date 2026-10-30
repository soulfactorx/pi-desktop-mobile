import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand, shQuote, type RemoteRunner } from "./bundle";

import type { SshHostConfig } from "./types";

export type { SshHostConfig };

/**
 * SSH 호스트 지원 (설계 §3.2 SSH transport, §5.6).
 *
 * - 연결은 OS의 `ssh`로 한다. 인증은 키와 ssh-agent에 맡기고 앱은 비밀번호를 묻거나 저장하지 않는다.
 *   그래서 항상 BatchMode로 실행한다: 비밀번호가 필요하면 묻지 않고 실패한다.
 * - 처음 보는 서버의 호스트 키는 받아들이고(accept-new), 바뀐 키는 거부한다 (ssh 기본 보호 유지).
 * - 연결이 조용히 끊긴 것을 알아채도록 keep-alive를 보낸다. 끊기면 앱이 다시 붙고, 데몬과 Pi는 서버에서 계속 돈다.
 * - 올리기는 WSL과 같다 (bundle.ts·kit.ts). Pi Desktop의 apps/desktop/src/main/ssh.ts에서 가져왔다.
 */

export const SSH_PREFIX = "ssh:";

/** 실행할 ssh. Windows는 Git 등 다른 ssh보다 OS에 딸린 OpenSSH를 먼저 쓴다 (~/.ssh 설정을 같이 읽는다). */
export function sshExecutable(platform: string = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (platform === "win32") {
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (exists(system)) return system;
  }
  return "ssh";
}

/**
 * ssh 공통 인자. 대상은 맨 끝이다. 그 뒤에 원격 명령을 붙인다.
 * @param tty 터미널을 붙일지 (-t). 연결기·스크립트 실행은 붙이지 않는다 (-T)
 */
export function sshArgs(host: SshHostConfig, tty = false): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=accept-new",
    ...(host.port ? ["-p", String(host.port)] : []),
    tty ? "-t" : "-T",
    host.target,
  ];
}

/**
 * 원격 셸에 넘길 명령. ssh는 명령을 원격 사용자의 로그인 셸이 해석하므로,
 * 셸 종류(bash, zsh 등)와 상관없이 같은 동작이 되도록 sh -c로 감싼다.
 */
export function remoteSh(script: string): string {
  return `sh -c ${shQuote(script)}`;
}

/**
 * 호스트 설정이 올바른지 본다. 틀렸으면 사용자에게 보여 줄 문구.
 * 대상이 "-"로 시작하면 ssh가 옵션으로 읽으므로 막는다.
 */
export function validateSshHost(host: SshHostConfig): string | undefined {
  if (!host.name.trim()) return "이름을 입력하세요";
  if (!host.target.trim()) return "접속 대상을 입력하세요 (예: user@192.168.0.10 또는 ~/.ssh/config의 Host 이름)";
  if (/\s/.test(host.target.trim()) || host.target.trim().startsWith("-")) return "접속 대상에 공백이나 앞쪽 '-'를 쓸 수 없습니다";
  if (host.port !== undefined && !(Number.isInteger(host.port) && host.port > 0 && host.port < 65536)) {
    return "포트는 1~65535 사이의 숫자여야 합니다";
  }
  return undefined;
}

/** 그 서버에서 셸 스크립트를 실행하는 명령 (stdin으로 바이트를 그대로 넘길 수 있다) */
export function sshShell(host: SshHostConfig): (script: string) => { command: string; args: string[] } {
  const ssh = sshExecutable();
  return (script) => ({ command: ssh, args: [...sshArgs(host), remoteSh(script)] });
}

/** 그 서버에서 스크립트를 실행해 출력을 받는다 */
export function sshRunner(host: SshHostConfig): RemoteRunner {
  const shell = sshShell(host);
  return (script, input) => {
    const { command, args } = shell(script);
    return runCommand(command, args, `SSH(${host.name})`, input);
  };
}

/** ssh 오류에 무엇을 하면 되는지 덧붙인다. */
export function explainSshError(message: string): string {
  if (/Permission denied/i.test(message)) {
    return `${message}\n키 인증이 필요합니다. 앱은 비밀번호를 묻지 않습니다. ssh-keygen으로 키를 만들고 서버의 ~/.ssh/authorized_keys에 공개 키를 등록하세요.`;
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) {
    return `${message}\n서버의 호스트 키가 예전과 다릅니다. 서버가 바뀐 것이 맞는지 확인한 뒤 ~/.ssh/known_hosts에서 예전 키를 지우세요.`;
  }
  if (/timed out|Connection refused|No route to host|Could not resolve/i.test(message)) {
    return `${message}\n서버 주소·포트와 sshd가 켜져 있는지 확인하세요.`;
  }
  return message;
}
