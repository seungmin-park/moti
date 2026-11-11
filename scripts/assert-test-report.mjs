import assert from "node:assert/strict";

function assertLayers(report, layers) {
  assert.equal(report.success, true, "DB 테스트 결과가 실패했습니다.");
  assert.ok(Array.isArray(report.testResults), "DB 테스트 결과 파일이 없습니다.");
  const counts = Object.fromEntries(layers.map((layer) => [layer, 0]));
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
  assert.ok(layers.every((layer) => counts[layer] > 0), `${layers.join(", ")} 테스트가 모두 실행되어야 합니다.`);
  const total = layers.reduce((sum, layer) => sum + counts[layer], 0);
  assert.equal(report.numTotalTests, total, "DB 테스트 실행 개수가 일치하지 않습니다.");
  assert.equal(report.numPassedTests, total, "DB 테스트 통과 개수가 일치하지 않습니다.");
  return counts;
}

export function assertDatabaseReport(report) {
  return assertLayers(report, ["persistence", "service"]);
}

export function assertHttpReport(report) {
  return assertLayers(report, ["http"]).http;
}

const browserProjects = ["desktop-chromium", "iphone-webkit"];

function* browserTests(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) yield* spec.tests ?? [];
    yield* browserTests(suite.suites);
  }
}

export function assertBrowserReport(report) {
  assert.deepEqual(report.errors ?? [], [], "브라우저 테스트 실행 오류가 있습니다.");
  const { expected, unexpected, flaky, skipped } = report.stats ?? {};
  assert.equal(unexpected, 0, "브라우저 테스트가 실패했습니다.");
  assert.equal(flaky, 0, "재시도로 통과한 브라우저 테스트는 완료가 아닙니다.");
  assert.equal(skipped, 0, "skip된 브라우저 테스트는 완료가 아닙니다.");
  assert.ok(expected > 0, "실행한 브라우저 테스트가 없습니다.");
  const counts = Object.fromEntries(browserProjects.map((project) => [project, 0]));
  let total = 0;
  for (const test of browserTests(report.suites)) {
    assert.equal(test.status, "expected", "브라우저 테스트의 실패·skip·flaky는 완료가 아닙니다.");
    assert.equal(test.expectedStatus, "passed", "실패를 기대하는 브라우저 테스트는 완료가 아닙니다.");
    if (test.projectName in counts) counts[test.projectName] += 1;
    total += 1;
  }
  assert.ok(browserProjects.every((project) => counts[project] > 0), `${browserProjects.join(", ")}에서 모두 실행되어야 합니다.`);
  assert.equal(total, expected, "브라우저 테스트 실행 개수가 일치하지 않습니다.");
  return total;
}
