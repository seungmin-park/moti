import { describe, expect, it, vi } from "vitest";
import type { ScheduledRunCommand, ScheduledRunResult } from "../application/commands";
import type { WorkerErrorCode } from "../domain/worker";
import { scheduledRunErrorResponseSchema, scheduledRunResponseSchema } from "./worker-dto";
import { createWorkerHandlers, type WorkerRequestContext } from "./worker-handlers";

const body = "AbcdEfghIjklMnopQrstUvwxYz0123456789-_AbCdE";
const secret = `moti_wk_${body}`;
const path = "https://moti.test/api/scheduled-runs";
const finished: ScheduledRunResult = {
  kind: "finished",
  stop: "done",
  collections: { collected: 3, failed: 1 },
  prices: { confirmed: 0, kept: 0 },
  failures: { blocked_by_site: 1 },
};

function given(configured = true) {
  const run = vi.fn<(command: ScheduledRunCommand) => Promise<ScheduledRunResult>>(async () => finished);
  const context = vi.fn(async (): Promise<WorkerRequestContext> => (configured ? { kind: "ready", service: { run } } : { kind: "unconfigured" }));
  return { handlers: createWorkerHandlers(context), run, context };
}

const post = (headers: Record<string, string> = { authorization: `Bearer ${secret}` }) =>
  new Request(path, { method: "POST", headers, body: JSON.stringify({ ignored: true }) });

async function answerOf(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  return response.json();
}

describe("POST /api/scheduled-runs: 가격 확인", () => {
  it("Given 가격을 확인하고 일부는 이전 가격을 지킨 실행 When 끝나면 Then 200과 가격 셈, 수집·가격의 이유별 셈을 계약대로 돌려준다", async () => {
    const { handlers, run } = given();
    const counted: ScheduledRunResult = {
      kind: "finished",
      stop: "deadline",
      collections: { collected: 3, failed: 1 },
      prices: { confirmed: 12, kept: 3 },
      failures: { blocked_by_site: 2, no_single_price: 1, other_currency: 1 },
    };
    run.mockResolvedValueOnce(counted);

    const response = await handlers.postScheduledRun(post());

    expect(response.status).toBe(200);
    expect(scheduledRunResponseSchema.parse(await answerOf(response))).toEqual({
      stop: "deadline",
      collections: { collected: 3, failed: 1 },
      prices: { confirmed: 12, kept: 3 },
      failures: { blocked_by_site: 2, no_single_price: 1, other_currency: 1 },
    });
  });
});

describe("POST /api/scheduled-runs: 작업 키", () => {
  it.each([
    ["Authorization 없음", {}],
    ["Basic 인증", { authorization: `Basic ${secret}` }],
    ["공유 키", { authorization: `Bearer moti_sk_${body}` }],
    ["형식이 다른 키", { authorization: "Bearer moti_wk_short" }],
    ["두 Authorization 값", { authorization: `Bearer ${secret}, Bearer ${secret}` }],
    ["소유자 쿠키만", { cookie: "sb-127-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJ4In0" }],
  ])("Given %s When 실행을 요청하면 Then 401이고 본문을 읽지 않으며 실행을 시작하지 않는다", async (_name, headers) => {
    const { handlers, run, context } = given();
    const request = post(headers);

    const response = await handlers.postScheduledRun(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(scheduledRunErrorResponseSchema.parse(await answerOf(response))).toEqual({
      error: "worker_key_rejected",
      message: "작업 키가 맞지 않거나 폐기됐어요. moti의 자동 확인에서 새 키를 만들어 GitHub 비밀값 MOTI_WORKER_TOKEN을 바꿔 주세요.",
    });
    expect(request.bodyUsed).toBe(false);
    expect(context).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("Given 모르거나 폐기한 키 When 실행이 거절되면 Then 형식이 틀린 키와 바이트까지 같은 401이다", async () => {
    const malformed = await given().handlers.postScheduledRun(post({ authorization: "Bearer nope" }));
    const { handlers, run } = given();
    run.mockResolvedValueOnce({ kind: "refused", code: "key_rejected" });
    const unknown = await handlers.postScheduledRun(post());

    expect([malformed.status, unknown.status]).toEqual([401, 401]);
    expect(unknown.headers.get("www-authenticate")).toBe("Bearer");
    expect(await unknown.text()).toBe(await malformed.text());
  });

  it("Given 맞는 키와 소유자 쿠키 When 실행을 요청하면 Then 키만 실행에 넘기고 본문을 읽지 않는다", async () => {
    const { handlers, run } = given();
    const request = post({ authorization: `bearer ${secret}`, cookie: "sb-127-auth-token=x" });

    const response = await handlers.postScheduledRun(request);

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ secret });
    expect(request.bodyUsed).toBe(false);
  });
});

describe("POST /api/scheduled-runs: 결과", () => {
  it("Given 실행이 끝남 When 응답하면 Then 200과 멈춘 이유·셈·실패 이유만 돌려준다", async () => {
    const response = await given().handlers.postScheduledRun(post());

    expect(response.status).toBe(200);
    expect(scheduledRunResponseSchema.parse(await answerOf(response))).toEqual({
      stop: "done",
      collections: { collected: 3, failed: 1 },
      prices: { confirmed: 0, kept: 0 },
      failures: { blocked_by_site: 1 },
    });
  });

  it.each([
    ["run_busy", 409, "run_busy"],
    ["run_lost", 409, "run_lost"],
    ["run_limit", 429, "run_limit"],
    ["storage_unavailable", 503, "unavailable"],
  ] as const)("Given %s When 실행이 거절되면 Then %i %s다", async (code: WorkerErrorCode, status, error) => {
    const { handlers, run } = given();
    run.mockResolvedValueOnce({ kind: "refused", code });

    const response = await handlers.postScheduledRun(post());

    expect(response.status).toBe(status);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(scheduledRunErrorResponseSchema.parse(await answerOf(response))).toMatchObject({ error });
  });

  it("Given 서버에 Supabase 설정이 없음 When 실행을 요청하면 Then 503 unconfigured다", async () => {
    const response = await given(false).handlers.postScheduledRun(post());
    expect(response.status).toBe(503);
    expect(await answerOf(response)).toMatchObject({ error: "unconfigured" });
  });

  it("Given 조립이 실패 When 실행을 요청하면 Then 503 unavailable이다", async () => {
    const handlers = createWorkerHandlers(async () => {
      throw new Error("boom");
    });
    const response = await handlers.postScheduledRun(post());
    expect(response.status).toBe(503);
    expect(await answerOf(response)).toMatchObject({ error: "unavailable" });
  });
});
