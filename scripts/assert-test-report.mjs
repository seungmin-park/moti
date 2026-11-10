import assert from "node:assert/strict";

export function assertDatabaseReport(report) {
  assert.equal(report.success, true, "DB 테스트 결과가 실패했습니다.");
  assert.ok(Array.isArray(report.testResults), "DB 테스트 결과 파일이 없습니다.");
  const counts = { persistence: 0, service: 0 };
  for (const file of report.testResults) {
    assert.ok(Array.isArray(file.assertionResults), "실행한 테스트 결과가 없습니다.");
    for (const assertion of file.assertionResults) {
      assert.equal(assertion.status, "passed", "DB 테스트의 실패·skip·todo는 완료가 아닙니다.");
    }
    for (const layer of Object.keys(counts)) {
      if (file.name.replaceAll("\\", "/").includes(`/tests/${layer}/`)) {
        counts[layer] += file.assertionResults.length;
      }
    }
  }
  assert.ok(counts.persistence > 0 && counts.service > 0, "Persistence와 Service 테스트가 모두 실행되어야 합니다.");
  const total = counts.persistence + counts.service;
  assert.equal(report.numTotalTests, total, "DB 테스트 실행 개수가 일치하지 않습니다.");
  assert.equal(report.numPassedTests, total, "DB 테스트 통과 개수가 일치하지 않습니다.");
  return counts;
}
