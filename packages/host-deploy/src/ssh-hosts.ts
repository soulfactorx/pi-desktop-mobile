import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateSshHost, type SshHostConfig } from "./ssh";

/**
 * 사용자가 등록한 SSH 호스트 목록 (앱 userData의 JSON 파일).
 * 인증 정보는 담지 않는다: 이름·대상·포트뿐이다.
 */
export class SshHostStore {
  private hosts: SshHostConfig[];

  constructor(private readonly file: string) {
    this.hosts = readHosts(file);
  }

  list(): SshHostConfig[] {
    return this.hosts.map((h) => ({ ...h }));
  }

  get(name: string): SshHostConfig | undefined {
    const host = this.hosts.find((h) => h.name === name);
    return host ? { ...host } : undefined;
  }

  /** 추가하거나 고친다. previousName이 있으면 그 호스트를 바꾼다 (이름도 바꿀 수 있다) */
  save(input: SshHostConfig, previousName?: string): SshHostConfig {
    const host: SshHostConfig = {
      name: input.name.trim(),
      target: input.target.trim(),
      ...(input.port !== undefined ? { port: input.port } : {}),
    };
    const problem = validateSshHost(host);
    if (problem) throw new Error(problem);
    if (this.hosts.some((h) => h.name === host.name && h.name !== previousName)) {
      throw new Error(`같은 이름의 SSH 호스트가 있습니다: ${host.name}`);
    }
    const at = previousName === undefined ? -1 : this.hosts.findIndex((h) => h.name === previousName);
    if (at >= 0) this.hosts[at] = host;
    else this.hosts.push(host);
    this.write();
    return { ...host };
  }

  remove(name: string): void {
    this.hosts = this.hosts.filter((h) => h.name !== name);
    this.write();
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ hosts: this.hosts }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

/** 파일이 없거나 깨졌으면 빈 목록. 형식이 맞지 않는 항목은 버린다 */
function readHosts(file: string): SshHostConfig[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { hosts?: unknown };
    if (!Array.isArray(data.hosts)) return [];
    return data.hosts.filter(
      (h): h is SshHostConfig =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as SshHostConfig).name === "string" &&
        typeof (h as SshHostConfig).target === "string" &&
        validateSshHost(h as SshHostConfig) === undefined,
    );
  } catch {
    return [];
  }
}
