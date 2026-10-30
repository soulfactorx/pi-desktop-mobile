import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 실제 Pi 프로세스를 띄우는 테스트가 있어 기본 5초로는 부족하다.
    testTimeout: 60_000,
  },
});
