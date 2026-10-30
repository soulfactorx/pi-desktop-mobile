import { execFile } from "node:child_process";
import { runCommand, type RemoteRunner } from "./bundle";

/**
 * WSL 호스트 (설계 DESIGN.md §3.2 WSL transport, §5.5). Pi Desktop의 apps/desktop/src/main/wsl.ts에서 가져와
 * Agent·Mate가 함께 쓰도록 배포(올리기)와 실행 명령을 나눴다 (DESIGN-MATE-REMOTE.md §3.3).
 */

const WSL_EXE = "wsl.exe";

/**
 * `wsl.exe -l -q` 출력에서 배포판 이름을 뽑는다.
 * wsl.exe는 UTF-16LE로 출력하고, 앞에 BOM이나 줄 끝에 CR이 붙을 수 있다.
 */
export function parseDistroList(output: Buffer): string[] {
  const text = looksUtf16(output) ? output.toString("utf16le") : output.toString("utf8");
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter((line) => line.length > 0);
}

/** 짝수 바이트 위치마다 0이 많으면 UTF-16LE로 본다 (ASCII 배포판 이름 기준). */
function looksUtf16(buffer: Buffer): boolean {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true;
  let zeros = 0;
  for (let i = 1; i < Math.min(buffer.length, 64); i += 2) if (buffer[i] === 0) zeros++;
  return zeros > 0 && zeros >= Math.min(buffer.length, 64) / 4;
}

/** 설치된 WSL 배포판 목록. WSL이 없거나 Windows가 아니면 빈 배열. */
export function listWslDistros(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(WSL_EXE, ["-l", "-q"], { encoding: "buffer", timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : parseDistroList(stdout));
    });
  });
}

/** 그 배포판의 홈에서 셸 스크립트를 실행하는 명령 (stdin으로 바이트를 그대로 넘길 수 있다) */
export function wslShell(distro: string): (script: string) => { command: string; args: string[] } {
  return (script) => ({ command: WSL_EXE, args: ["-d", distro, "--cd", "~", "--exec", "sh", "-c", script] });
}

/** 그 배포판에서 스크립트를 실행해 출력을 받는다 */
export function wslRunner(distro: string): RemoteRunner {
  const shell = wslShell(distro);
  return (script, input) => {
    const { command, args } = shell(script);
    return runCommand(command, args, `WSL(${distro})`, input);
  };
}
