/**
 * pi-resources의 타입만 (화면에서 node 모듈 없이 쓰도록 따로 둔다).
 */

export interface PackageView {
  /** settings.json에 적힌 출처 (npm:이름, git:주소, 경로) */
  source: string;
  /** 보기 좋은 이름 */
  name: string;
  /** 설치된 폴더. 없으면 아직 설치되지 않았거나 경로를 모른다 */
  path?: string;
}

export interface PackageResult {
  ok: boolean;
  output: string;
  packages: PackageView[];
}

export type AppId = "desktop" | "agent" | "mate";

export interface AppHome {
  app: AppId;
  label: string;
  home: string;
}

export interface ImportableSkill {
  from: AppId;
  fromLabel: string;
  name: string;
  description: string;
  /** 이 홈에 같은 이름이 이미 있다 */
  exists: boolean;
}

export interface ImportablePackage {
  from: AppId;
  fromLabel: string;
  source: string;
  name: string;
  exists: boolean;
}

export interface Importables {
  skills: ImportableSkill[];
  packages: ImportablePackage[];
}
