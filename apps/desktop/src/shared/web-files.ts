/**
 * Pi Web 파일 관리자의 채널과 화면 API (설계 §5.10 "파일 관리자"). 웹에만 있다 (데스크톱 앱은 OS 파일 관리자를 쓴다).
 * 화면은 window.piWeb.files로 쓴다 (web/main.ts가 둔다).
 */
export const FileChannels = {
  list: "pi-web:files-list",
  makeDir: "pi-web:files-mkdir",
  makeFile: "pi-web:files-mkfile",
  rename: "pi-web:files-rename",
  transfer: "pi-web:files-transfer",
  remove: "pi-web:files-remove",
  readText: "pi-web:files-read",
  writeText: "pi-web:files-write",
  upload: "pi-web:files-upload",
  downloadTicket: "pi-web:files-download",
} as const;

/** 내려받기 주소 (티켓을 붙인다) */
export const FILE_DOWNLOAD_PATH = "/api/files/download";

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  link: boolean;
  size: number;
  mtime: number;
}

export interface FileListing {
  path: string;
  parent?: string;
  entries: FileEntry[];
}

export interface WebFilesApi {
  list(path?: string): Promise<FileListing>;
  makeDir(parent: string, name: string): Promise<string>;
  makeFile(parent: string, name: string): Promise<string>;
  rename(path: string, name: string): Promise<string>;
  transfer(paths: string[], destDir: string, mode: "move" | "copy"): Promise<string[]>;
  remove(paths: string[]): Promise<number>;
  readText(path: string): Promise<{ text: string; mtime: number }>;
  writeText(path: string, text: string, baseMtime?: number): Promise<number>;
  upload(dir: string, file: File): Promise<string>;
  /** 브라우저가 파일을 내려받게 한다 */
  download(path: string): Promise<void>;
}

declare global {
  interface Window {
    /** 웹에만 있는 기능 (pi-web). 데스크톱 앱에는 없다 */
    piWeb?: { files: WebFilesApi };
  }
}
