import { FILE_DOWNLOAD_PATH, FileChannels, type WebFilesApi } from "../shared/web-files";

/** 파일 관리자의 화면 쪽 API (window.piWeb.files). 서버 연결은 invoke만 쓴다 */
export function createWebFiles(invoke: (channel: string, ...args: unknown[]) => Promise<any>): WebFilesApi {
  return {
    list: (path) => invoke(FileChannels.list, path),
    makeDir: (parent, name) => invoke(FileChannels.makeDir, parent, name),
    makeFile: (parent, name) => invoke(FileChannels.makeFile, parent, name),
    rename: (path, name) => invoke(FileChannels.rename, path, name),
    transfer: (paths, dest, mode) => invoke(FileChannels.transfer, paths, dest, mode),
    remove: (paths) => invoke(FileChannels.remove, paths),
    readText: (path) => invoke(FileChannels.readText, path),
    writeText: (path, text, baseMtime) => invoke(FileChannels.writeText, path, text, baseMtime),
    upload: async (dir, file) => invoke(FileChannels.upload, dir, file.name, await base64(file)),
    download: async (path) => {
      const { url } = (await invoke(FileChannels.downloadTicket, path)) as { url: string };
      if (!url.startsWith(FILE_DOWNLOAD_PATH)) throw new Error("내려받기 주소가 올바르지 않습니다");
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").pop() ?? "file";
      document.body.append(link);
      link.click();
      link.remove();
    },
  };
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다"));
    reader.readAsDataURL(file);
  });
}
