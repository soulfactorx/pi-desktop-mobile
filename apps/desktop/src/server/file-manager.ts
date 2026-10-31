import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileEntry, FileListing } from "../shared/web-files";

/**
 * Pi Web의 파일 관리자 (설계 §5.10 "파일 관리자"). 서버(휴대폰의 Termux)의 파일을 브라우저에서 다룬다.
 * Termux 홈은 안드로이드 파일 앱으로 열 수 없어서, 화면에서 훑고·만들고·옮기고·지우고·올리고·내려받게 한다.
 *
 * - 다룰 수 있는 곳은 홈 폴더 아래뿐이다 (경로를 글자로 견준다. ~/storage처럼 홈 안의 링크를 따라 공용 저장소로 가는 것은 된다)
 * - 지우기는 정말 지운다 (화면이 한 번 더 묻는다)
 * - 텍스트 읽기·쓰기는 2MB까지, 올리기는 한 파일 100MB까지
 * - 내려받기는 브라우저가 링크로 받으므로 60초짜리 일회용 티켓 주소를 준다 (토큰을 주소에 넣지 않게)
 */

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const TICKET_MS = 60_000;

export class FileManager {
  private readonly tickets = new Map<string, { path: string; expires: number }>();

  constructor(readonly root: string = homedir()) {}

  /** 홈 아래의 절대 경로로 바꾼다. 밖이면 오류 ("~"는 홈) */
  resolvePath(path: string | undefined): string {
    const raw = (path ?? "").trim();
    const full = resolve(raw === "" || raw === "~" ? this.root : raw.startsWith("~/") ? join(this.root, raw.slice(2)) : isAbsolute(raw) ? raw : join(this.root, raw));
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`홈 폴더(${this.root}) 밖은 다룰 수 없습니다: ${full}`);
    return full;
  }

  async list(path?: string): Promise<FileListing> {
    const dir = this.resolvePath(path);
    const names = await readdir(dir, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const entry of names) {
      const full = join(dir, entry.name);
      const link = entry.isSymbolicLink();
      const info = await stat(full).catch(() => undefined);
      entries.push({ name: entry.name, path: full, dir: info?.isDirectory() ?? false, link, size: info?.size ?? 0, mtime: info?.mtimeMs ?? 0 });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { path: dir, ...(dir !== this.root ? { parent: dirname(dir) } : {}), entries };
  }

  async makeDir(parent: string, name: string): Promise<string> {
    const target = join(this.resolvePath(parent), checkName(name));
    await mkdir(target);
    return target;
  }

  async makeFile(parent: string, name: string): Promise<string> {
    const target = join(this.resolvePath(parent), checkName(name));
    await writeFile(target, "", { flag: "wx" });
    return target;
  }

  async rename(path: string, name: string): Promise<string> {
    const from = this.resolvePath(path);
    if (from === this.root) throw new Error("홈 폴더는 바꿀 수 없습니다");
    const to = join(dirname(from), checkName(name));
    await this.mustNotExist(to);
    await rename(from, to);
    return to;
  }

  /** 여러 파일·폴더를 폴더로 옮기거나 복사한다. 같은 이름이 있으면 멈춘다 (덮어쓰지 않는다) */
  async transfer(paths: string[], destDir: string, mode: "move" | "copy"): Promise<string[]> {
    const dest = this.resolvePath(destDir);
    if (!(await stat(dest)).isDirectory()) throw new Error("옮길 곳이 폴더가 아닙니다");
    const done: string[] = [];
    for (const path of paths) {
      const from = this.resolvePath(path);
      if (from === this.root) throw new Error("홈 폴더는 옮길 수 없습니다");
      if (dest === from || dest.startsWith(from + sep)) throw new Error(`폴더를 자기 안으로 옮길 수 없습니다: ${basename(from)}`);
      const to = join(dest, basename(from));
      await this.mustNotExist(to);
      if (mode === "copy") await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      else {
        try {
          await rename(from, to);
        } catch (error) {
          // 다른 저장소(~/storage의 공용 저장소 등)로는 rename이 안 되어 복사 후 지운다
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
          await rm(from, { recursive: true, force: true });
        }
      }
      done.push(to);
    }
    return done;
  }

  async remove(paths: string[]): Promise<number> {
    for (const path of paths) {
      const target = this.resolvePath(path);
      if (target === this.root) throw new Error("홈 폴더는 지울 수 없습니다");
      // 링크는 링크만 지운다 (가리키는 곳은 그대로)
      await rm(target, { recursive: !(await lstat(target)).isSymbolicLink(), force: false });
    }
    return paths.length;
  }

  async readText(path: string): Promise<{ text: string; mtime: number }> {
    const target = this.resolvePath(path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("파일이 아닙니다");
    if (info.size > MAX_TEXT_BYTES) throw new Error(`${(info.size / 1024 / 1024).toFixed(1)}MB라 화면에서 열기에 너무 큽니다 (2MB까지). 내려받아 보세요`);
    const data = await readFile(target);
    if (data.includes(0)) throw new Error("글 파일이 아닌 것 같습니다 (내려받아 보세요)");
    return { text: data.toString("utf8"), mtime: info.mtimeMs };
  }

  /** baseMtime을 주면 그 사이 다른 곳에서 바뀌었을 때 덮어쓰지 않는다 */
  async writeText(path: string, text: string, baseMtime?: number): Promise<number> {
    const target = this.resolvePath(path);
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("2MB가 넘어 저장할 수 없습니다");
    if (baseMtime !== undefined) {
      const now = await stat(target).catch(() => undefined);
      if (now && Math.abs(now.mtimeMs - baseMtime) > 1) throw new Error("연 뒤에 다른 곳에서 파일이 바뀌었습니다. 다시 열어 고치세요");
    }
    await writeFile(target, text, "utf8");
    return (await stat(target)).mtimeMs;
  }

  /** 휴대폰에서 고른 파일을 이 폴더에 올린다. 같은 이름이 있으면 (1), (2)를 붙인다 */
  async upload(dir: string, name: string, base64: string): Promise<string> {
    const data = Buffer.from(base64, "base64");
    if (data.length > MAX_UPLOAD_BYTES) throw new Error(`${(data.length / 1024 / 1024).toFixed(1)}MB라 너무 큽니다 (100MB까지)`);
    const parent = this.resolvePath(dir);
    const safe = checkName(basename(name).replace(/[\\/:*?"<>|\0]/g, "_") || "file");
    const dot = safe.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    let target = join(parent, safe);
    for (let n = 1; await exists(target); n++) target = join(parent, `${stem} (${n})${ext}`);
    await writeFile(target, data, { flag: "wx" });
    return target;
  }

  /** 내려받기 티켓 (60초, 한 번) */
  async downloadTicket(path: string): Promise<string> {
    const target = this.resolvePath(path);
    if (!(await stat(target)).isFile()) throw new Error("파일만 내려받을 수 있습니다");
    const now = Date.now();
    for (const [key, t] of this.tickets) if (t.expires < now) this.tickets.delete(key);
    const ticket = randomBytes(18).toString("base64url");
    this.tickets.set(ticket, { path: target, expires: now + TICKET_MS });
    return ticket;
  }

  /** 티켓이 맞으면 파일을 내려보낸다. 아니면 false */
  async serveDownload(ticket: string | null, res: ServerResponse): Promise<boolean> {
    const entry = ticket ? this.tickets.get(ticket) : undefined;
    if (!ticket || !entry || entry.expires < Date.now()) return false;
    this.tickets.delete(ticket);
    const info = await stat(entry.path).catch(() => undefined);
    if (!info?.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(entry.path))}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(entry.path).pipe(res);
    return true;
  }

  private async mustNotExist(path: string): Promise<void> {
    if (await exists(path)) throw new Error(`같은 이름이 이미 있습니다: ${basename(path)}`);
  }
}

function checkName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/\0]/.test(trimmed)) throw new Error("이름에 / 를 쓰거나 비워 둘 수 없습니다");
  return trimmed;
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}
