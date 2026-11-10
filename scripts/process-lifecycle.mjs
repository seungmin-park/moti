import { execFile } from "node:child_process";
export function executeUntilClosed(file, args, options) {
  return new Promise((resolve, reject) => {
    let outcome;
    let closed = false;
    const finish = () => {
      if (!closed || !outcome) return;
      if (outcome.error) {
        Object.assign(outcome.error, { stdout: outcome.stdout, stderr: outcome.stderr });
        reject(outcome.error);
      } else {
        resolve({ stdout: outcome.stdout, stderr: outcome.stderr });
      }
    };
    const child = execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      outcome = { error, stdout, stderr };
      finish();
    });
    child.once("close", () => { closed = true; finish(); });
  });
}

export async function withTermination(action, cleanup) {
  const controller = new AbortController();
  let interrupted;
  const handlers = Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }).map(([signal, code]) => {
    const handler = () => {
      interrupted ??= code;
      controller.abort(new Error(`Received ${signal}`));
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    let result;
    try {
      result = await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      await cleanup();
    }
    return interrupted ?? result ?? 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
