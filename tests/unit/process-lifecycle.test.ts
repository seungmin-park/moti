import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executeUntilClosed } from "../../scripts/process-lifecycle.mjs";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("DB 실행기의 종료 정리", () => {
  it("시작 명령 중단 뒤 실제 자식 프로세스가 닫혀야 정리로 넘어간다", async () => {
    const folder = mkdtempSync(join(tmpdir(), "moti-lifecycle-"));
    folders.push(folder);
    const ready = join(folder, "ready");
    const closed = join(folder, "closed");
    const controller = new AbortController();
    const program = `
      const fs = require('node:fs');
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0);
      }, 50));
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    `;
    const execution = executeUntilClosed(process.execPath, ["-e", program], { signal: controller.signal });
    try {
      await expect.poll(() => existsSync(ready)).toBe(true);
      controller.abort();
      await expect(execution).rejects.toMatchObject({ code: "ABORT_ERR" });
      expect(existsSync(closed), "start CLI가 종료되기 전에 stop을 시작하면 안 된다").toBe(true);
    } finally {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)(
    "%s가 와도 실행을 중단하고 비동기 정리를 마친다",
    async (signal, exitCode) => {
      const folder = mkdtempSync(join(tmpdir(), "moti-lifecycle-"));
      folders.push(folder);
      const marker = join(folder, "cleaned");
      const helper = pathToFileURL(resolve("scripts/process-lifecycle.mjs")).href;
      const program = `
        import { withTermination } from ${JSON.stringify(helper)};
        import { writeFile } from 'node:fs/promises';
        process.exitCode = await withTermination(async (signal) => {
          await new Promise((resolve) => {
            const timer = setInterval(() => {}, 1000);
            signal.addEventListener('abort', () => { clearInterval(timer); resolve(); }, { once: true });
            console.log('ready');
          });
          return 0;
        }, async () => {
          await new Promise(resolve => setTimeout(resolve, 25));
          await writeFile(${JSON.stringify(marker)}, 'cleaned');
        });
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
      try {
        await once(child.stdout, "data");
        const closed = once(child, "close");
        child.kill(signal);
        const [code] = await closed;
        expect(existsSync(marker), "종료 신호 뒤에도 정리 callback이 실행되어야 한다").toBe(true);
        expect(code).toBe(exitCode);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
    },
  );
});
