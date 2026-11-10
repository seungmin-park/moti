import { describe, expect, it } from "vitest";
import { assertDatabaseReport, assertHttpReport } from "../../scripts/assert-test-report.mjs";

function completedReport() {
  return {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    testResults: ["persistence", "service"].map((layer) => ({
      name: `/workspace/tests/${layer}/library.test.ts`,
      assertionResults: [{ status: "passed", title: "stores a link" }],
    })),
  };
}

describe("DB 검증 완료 판정", () => {
  it("persistence와 service가 모두 실제로 통과한 결과를 받는다", () => {
    expect(() => assertDatabaseReport(completedReport())).not.toThrow();
  });

  it("모든 테스트가 skip된 성공 표시는 거절한다", () => {
    const report = completedReport();
    report.numPassedTests = 0;
    for (const file of report.testResults) file.assertionResults[0].status = "pending";
    expect(() => assertDatabaseReport(report)).toThrow();
  });

  it("테스트 0개와 한 계층의 누락을 거절한다", () => {
    expect(() => assertDatabaseReport({ ...completedReport(), testResults: [] })).toThrow();
    expect(() => assertDatabaseReport({ ...completedReport(), testResults: completedReport().testResults.slice(0, 1) })).toThrow();
  });

  it("성공 요약 안의 실패·todo와 실행 개수 불일치를 거절한다", () => {
    for (const status of ["failed", "todo"]) {
      const report = completedReport();
      report.testResults[1].assertionResults[0].status = status;
      expect(() => assertDatabaseReport(report)).toThrow();
    }
    expect(() => assertDatabaseReport({ ...completedReport(), numTotalTests: 3 })).toThrow();
  });
});

describe("HTTP 검증 완료 판정", () => {
  const httpReport = () => ({
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    testResults: [{ name: "/workspace/tests/http/library-api.test.ts", assertionResults: [{ status: "passed", title: "reads" }] }],
  });

  it("HTTP 계층이 실제로 통과한 결과의 개수를 돌려준다", () => {
    expect(assertHttpReport(httpReport())).toBe(1);
  });

  it("HTTP 테스트 0개와 skip을 거절한다", () => {
    expect(() => assertHttpReport({ ...httpReport(), numTotalTests: 0, numPassedTests: 0, testResults: [] })).toThrow();
    const skipped = httpReport();
    skipped.testResults[0].assertionResults[0].status = "pending";
    expect(() => assertHttpReport(skipped)).toThrow();
  });
});
