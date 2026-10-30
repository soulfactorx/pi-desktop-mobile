// Pi Desktop apps/desktop/test/main/ssh.test.ts에서 가져왔다 (터미널 부분은 Pi Desktop 전용이라 뺐다)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainSshError, remoteSh, sshArgs, sshExecutable, SshHostStore, validateSshHost } from "../src/index";

const phone = { name: "phone", target: "u0_a784@10.0.0.5", port: 8022 };

describe("sshExecutable", () => {
  it("Windows는 OS에 딸린 OpenSSH를 먼저, 없으면 PATH의 ssh", () => {
    expect(sshExecutable("win32", () => true)).toMatch(/System32[\\/]OpenSSH[\\/]ssh\.exe$/);
    expect(sshExecutable("win32", () => false)).toBe("ssh");
    expect(sshExecutable("linux", () => true)).toBe("ssh");
  });
});

describe("sshArgs", () => {
  it("비밀번호를 묻지 않고(BatchMode), keep-alive와 포트를 넣고, 대상은 맨 끝", () => {
    const args = sshArgs(phone);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args.join(" ")).toContain("-p 8022");
    expect(args.at(-2)).toBe("-T");
    expect(args.at(-1)).toBe("u0_a784@10.0.0.5");
  });

  it("포트가 없으면 넣지 않고, 터미널이면 -t", () => {
    const args = sshArgs({ name: "a", target: "alias" }, true);
    expect(args).not.toContain("-p");
    expect(args.at(-2)).toBe("-t");
  });
});

describe("remoteSh", () => {
  it("로그인 셸 종류와 상관없이 sh -c로 감싼다", () => {
    expect(remoteSh("echo 'a'")).toBe(`sh -c 'echo '\\''a'\\'''`);
  });
});

describe("validateSshHost", () => {
  it("이름·대상이 있어야 하고, 대상은 공백·앞쪽 - 금지, 포트는 1~65535", () => {
    expect(validateSshHost(phone)).toBeUndefined();
    expect(validateSshHost({ ...phone, name: " " })).toContain("이름");
    expect(validateSshHost({ ...phone, target: "-oProxyCommand=x" })).toContain("'-'");
    expect(validateSshHost({ ...phone, target: "a b" })).toContain("공백");
    expect(validateSshHost({ ...phone, port: 70000 })).toContain("포트");
  });
});

describe("explainSshError", () => {
  it("키 인증 실패에는 키 등록 안내를 붙인다", () => {
    expect(explainSshError("u@h: Permission denied (publickey,password).")).toContain("authorized_keys");
    expect(explainSshError("ssh: connect to host h port 22: Connection refused")).toContain("sshd");
    expect(explainSshError("그 밖의 오류")).toBe("그 밖의 오류");
  });
});

describe("SshHostStore", () => {
  it("추가·고치기(이름 변경 포함)·지우기를 파일에 저장하고 다시 읽는다", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pi-ssh-hosts-")), "ssh-hosts.json");
    const store = new SshHostStore(file);
    store.save({ name: " phone ", target: " u0_a784@10.0.0.5 ", port: 8022 });
    expect(store.list()).toEqual([phone]);
    expect(() => store.save({ name: "phone", target: "x" })).toThrow("같은 이름");
    store.save({ name: "galaxy", target: "u0_a784@10.0.0.6" }, "phone");
    expect(new SshHostStore(file).list()).toEqual([{ name: "galaxy", target: "u0_a784@10.0.0.6" }]);
    store.remove("galaxy");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hosts: [] });
  });

  it("깨진 파일이나 잘못된 항목은 버린다", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pi-ssh-hosts-")), "ssh-hosts.json");
    writeFileSync(file, JSON.stringify({ hosts: [phone, { name: "bad", target: "-x" }, 3] }));
    expect(new SshHostStore(file).list()).toEqual([phone]);
    writeFileSync(file, "{");
    expect(new SshHostStore(file).list()).toEqual([]);
  });
});
