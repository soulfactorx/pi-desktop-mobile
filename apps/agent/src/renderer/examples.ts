/**
 * 빈 대화에 보여 줄 "이런 일을 할 수 있어요" 예시. agent-kit 확장들이 하는 일을 사용자가 알 수 있게 한다
 * (desktop-agent의 기능이 어디로 옮겨졌는지 설계 DESIGN-AGENT.md §4).
 */
export interface Example {
  title: string;
  detail: string;
  prompt: string;
}

export const EXAMPLES: Example[] = [
  {
    title: "파일 살펴보고 정리",
    detail: "읽기는 바로, 쓰기·명령 실행은 승인을 받고 합니다",
    prompt: "이 폴더에 어떤 파일들이 있는지 살펴보고, 종류별로 정리해서 알려 줘.",
  },
  {
    title: "큰 문서 번역·요약",
    detail: "docx·pdf·긴 텍스트도 나눠서 처리합니다. 파일 첨부로 경로를 넣으세요",
    prompt: "첨부한 문서를 핵심만 다섯 줄로 요약해 줘.",
  },
  {
    title: "백그라운드로 맡기기",
    detail: "오래 걸리는 일은 워커가 하고, 끝나면 알림이 옵니다",
    prompt: "백그라운드로 이 폴더의 TODO 주석을 모두 찾아서 파일별로 정리해 줘.",
  },
  {
    title: "예약하기",
    detail: "앱을 닫아도 정해진 때에 돌고, 결과는 작업 화면에 남습니다",
    prompt: "매일 오전 9시에 다운로드 폴더를 살펴보고 새로 생긴 파일을 정리해서 알려 줘.",
  },
  {
    title: "웹 페이지 읽기",
    detail: "주소를 주면 본문을 읽어 옵니다 (사이트별로 승인)",
    prompt: "https://pi.dev 페이지를 읽고 무엇을 하는 도구인지 세 줄로 알려 줘.",
  },
  {
    title: "기억시키기",
    detail: "선호·규칙을 기억해 다음 대화부터 따릅니다",
    prompt: "/agent:remember 답은 짧게, 한국어로",
  },
];
