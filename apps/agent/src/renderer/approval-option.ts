/** "이 세션에서 계속 허용: https://wttr.in/**"를 범위 설명과 허용 패턴으로 나눈다 */
export function splitOption(option: string): { label: string; pattern?: string } {
  const at = option.indexOf(": ");
  return at < 0 ? { label: option } : { label: option.slice(0, at), pattern: option.slice(at + 2) };
}
