/** 화면(렌더러)도 쓰는 모양. 아무것도 import하지 않는다 */

export interface SshHostConfig {
  /** 화면에 보일 이름. 호스트 id("ssh:<이름>")에도 쓰여 겹칠 수 없다 */
  name: string;
  /** ssh에 넘기는 대상: user@host 또는 ~/.ssh/config의 Host 이름 */
  target: string;
  /** 비우면 ssh 기본값(22 또는 ~/.ssh/config) */
  port?: number;
}
