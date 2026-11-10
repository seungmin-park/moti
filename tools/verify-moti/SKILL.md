---
name: verify-moti
description: Verify moti wishlist behavior, responsive layouts and project checks after changes to its Next.js mockup.
---

# Verify moti

Run from the repository root. Read [feature-map.md](../../docs/feature-map.md) for the changed user flow and [mockup-contract.md](../../docs/mockup-contract.md) for failure cases. Data is session-only sample data. Reloading resets it.

Use Node 24 and the locked dependencies. Run `npm ci` when dependencies are missing or the lockfile changed. Install test browsers with `npm exec -- playwright install chromium webkit`.

For behavior changes, run a targeted failing test before implementation. `npm test` runs domain assertions. `npm run lint` includes the domain dependency boundary. `npm run typecheck` generates Next.js types before checking TypeScript.

Run `npm run build` before browser checks. `npm run test:e2e` starts a fresh production server on port 3101 and closes that owned server afterward. It refuses to reuse an existing process. A busy port is an environment failure; identify its owner before changing anything. PC Chromium and iPhone-sized WebKit assertions do not establish behavior on a physical iPhone.

Run `npm run build` first, then `npm run test:database` for persistence, service and HTTP behavior. Persistence and service run without Next; the HTTP phase then starts the built app on 127.0.0.1:56380 against the same isolated stack. It starts an isolated native Supabase stack with the committed migrations and runs without Next. See [test-database.md](../../docs/test-database.md) for supported platforms, cleanup and the distinction between local Auth fixtures and real Google OAuth. Never substitute mock repositories for this check or count a startup/permission failure as Red.

Run `npm run verify` for the final integrated change. Inspect the test count and actual assertions, not just the exit code. The suite must execute tests. CI runs the same checks on the PR's integration candidate. If a local runtime is unavailable, record the exact limitation and independently observe that suite in CI before claiming it passed.

For visual review, start `npm run dev` on port 3100, or `npm exec -- next start --hostname 127.0.0.1 --port 3102` after a fresh build. Confirm that the server belongs to this source. Use a visible browser where available; disclose tool unavailability. Headed Playwright is available with `npm exec -- playwright test --headed --workers=1`.

Capture layouts with `npm exec -- node scripts/capture-preview.mjs http://127.0.0.1:3102`. It checks overflow, font loading, image loading and page errors and writes `docs/evidence`. Read the screenshots. `npm exec -- node scripts/check-a11y.mjs http://127.0.0.1:3102` reports automated WCAG checks for the list and detail. Automated checks do not replace keyboard and visual review.

Stop only servers and browsers started for the check. Preserve the preview when handing it to the user. If the environment rejects stopping a server, record that fact and use a different port for later checks.

Record commands, test results, source revision and remaining limits in [verification.md](../../docs/verification.md). Follow the repository's current CI and review gates and confirm the actual merged state when merge is authorized. Deployment needs separate approval.
