# Brazil CRM fixture proof and pilot gates

2026-10-10. Base: f322ca41bc40c538803b173d7ce0003143df793b. Local-only test patch. No release, public push, merge, purchase, customer message or production change.

## Narrow pilot hypothesis

A Brazilian sales team can use the existing official channel to capture an inbound contact, open a lead in its default pipeline, and send a manual PT-BR reply. Start with human replies rather than claiming an autonomous sales agent. A fixture is preparation, not evidence of a paying buyer.

## Evidence and limits

- Existing adapter: `lib/channels/adapters/meta-cloud.ts`. Existing captured text/audio payloads: `tests/fixtures/meta/inbound-webhooks.json`. Existing adapter tests: 20; captured inbound tests: 11; locale tests: 17. Baseline: 48 passed in 7.08s.
- Added synthetic, explicitly labelled JSON fixture and four tests. Actual parser, ingest, post-entry effects, lead creation and outbound adapter execute. Database and HTTP are fake; local worker drain and audit are stubbed. No greenfield adapter or product behavior edits.
- Revised flow asserts captured contact/message/conversation/session/organization identifiers and lead/dispatch event payloads. Pipeline and stage fake rows include competing organizations, nondefault/archived pipelines, other-pipeline/archived/won/lost/later stages; the fake applies equality filters, stage ordering and limits. This proves the application query selects the fixture default and first eligible stage, NOT that real database constraints or RLS work. Other fake tables still use simplified canned data; organization query checks are assertions, not a cross-tenant isolation simulation. The pre-send callback is a spy, NOT proof that the full policy chain runs.
- Revised focused regression run: 10 files, 173 tests passed, 18.30s. Guardrail run: 5 files, 37 tests passed, 7.05s. Four new tests overlap these runs; do not add the counts as distinct tests.
- Independent checker rejected the original proof: nondefault pipeline, wrong stage pipeline and wrong message conversation mutations escaped. Revised test detects all three, plus reverse stage order: each mutation produced 1 failed / 3 passed, exit 1; production files were restored and 173 focused tests passed. These probes do not imply complete mutation coverage.
- Original assertion sensitivity check: deliberately wrong expected lead title failed one test (3 passed / 1 failed); restoring it passed. This is an assertion probe, not a production bug fix or a claimed red-green implementation.
- Changed test ESLint and Prettier checks passed. Frozen install with scripts disabled passed; no dependency or lockfile changes.
- Full unit suite was attempted with a 65-second bound and timed out (exit 124); no complete-suite green claim.
- Whole-repo typecheck first aborted with heap OOM (exit 134). Larger-heap retry exceeded execution limit, on a roughly 2GB workspace. No typecheck success is claimed.
- No live WABA, verified consent, database RLS/concurrency execution, browser/screenshots, worker/LLM response, hosted environment, payment flow or paid pilot verified.

## Licence matrix

| Surface                      | Source and status                                                             | Required treatment / unresolved gate                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository                   | `LICENSE`: MIT, copyright Rafael Melgaco, 2026                                | Preserve copyright and permission notice in distributed copies. No trademark/name clearance inferred.                                            |
| Main UI/runtime dependencies | Installed metadata below: mostly MIT; AI SDK and selected packages Apache-2.0 | Preserve applicable notices. Metadata inventory is not full transitive SBOM or legal clearance.                                                  |
| web-push                     | 3.6.7, MPL-2.0 in installed metadata                                          | File-level obligations need review if modified/distributed. No blanket MIT claim for the stack.                                                  |
| WAHA                         | Upstream core LICENSE is Apache-2.0                                           | Existing Docker image `devlikeapro/waha:noweb` is unpinned; exact image contents/licences not verified. Not used in this official-channel proof. |
| WAHA edition                 | Current vendor page says Plus merged into Core from 2026.6.1                  | Repo README's Plus wording is stale; no paid Plus requirement inferred. Container entitlement/digest still unverified.                           |
| Meta Cloud API               | Service integration, not covered by repository MIT                            | Account authority, current terms/pricing, consent and approved templates need verification before live use. No legal or zero-cost claim.         |
| Product name                 | Existing `APP_NAME` configuration supported; draft #1 untouched               | Public brand remains unresolved. Fixture uses neutral configurable test name.                                                                    |

WAHA sources inspected: https://github.com/devlikeapro/waha/blob/core/LICENSE and https://waha.devlike.pro/docs/how-to/waha-plus/

## Security matrix

| Boundary                | Source evidence / checks                                                                                          | Status and next gate                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook authenticity    | Route resolves session from path token, verifies HMAC before parser; existing webhook/route contract tests passed | No live handshake or replay/load test. Signature bytes malformed-input handling merits focused adversarial check.                                 |
| Tenant scope            | Ingest and credentials filter organization; tests assert query scope; existing tenant ingest tests passed         | Fake DB does not prove RLS, grants or cross-tenant RPC execution. Run real two-tenant invariants before pilot.                                    |
| Persistence/idempotence | Duplicate external ID handling exercised; lead RPC has advisory-lock migration                                    | Fake simulates duplicate constraint. Real migrations/constraints/races remain unverified.                                                         |
| Credentials             | Per-session encrypted-token resolution and env fallback exist; fixtures use only fake token                       | Provision via secure storage; validate encryption RPC/key and single-tenant fallback isolation. No credential changes.                            |
| Outbound policy         | Adapter separates transport from before-send gates; existing window/template tests passed                         | New fixture calls adapter directly. Production handler policy chain, opt-out and manual-send authorization still require actual end-to-end proof. |
| Media/network           | Adapter has media retrieval and Graph host override controls                                                      | No live media/download/SSRF/DNS-rebinding check; default pilot is text only.                                                                      |
| Personal data/LGPD      | New fixture is synthetic                                                                                          | Consent, privacy notice, retention/export/deletion and vendor sharing are not cleared by fixtures.                                                |
| Dependencies            | `pnpm audit --prod --json`: 2 critical, 7 high, 10 moderate, 1 low                                                | Known vulnerabilities found. Triage exposure and patch applicable runtime/build paths, then rerun gates. No forced upgrades in this patch.        |
| Runtime/build           | Targeted unit/lint/format green, typecheck not verified                                                           | Full build/browser/DB/invariant gates and independent checker outstanding.                                                                        |

High/critical findings from audit (paths are advisory evidence, not confirmed exploitability):

- Next 16.3.6 image optimization SSRF: https://github.com/advisories/GHSA-cjq9-62q9-8jv4 (audit suggests >=16.3.8).
- MCP SDK 1.30.1 OAuth credential disclosure: https://github.com/advisories/GHSA-6qxp-vccf-f47h (>=1.31.0).
- proxy-addr via MCP SDK > express: https://github.com/advisories/GHSA-jqcg-44mw-7w3h (>=2.0.8).
- seroval via react-query devtools > solid-js: https://github.com/advisories/GHSA-p6vx-979v-rg4c and https://github.com/advisories/GHSA-jp82-f5mq-hwhp (>=1.6.3 covers both per audit).
- sharp via Next: https://github.com/advisories/GHSA-wq5f-xc86-pv6w (>=0.35.5).
- brace-expansion via Sentry bundler plugins: https://github.com/advisories/GHSA-qhr7-859c-m2p7 and https://github.com/advisories/GHSA-6j4f-fj2g-mc7p (moderate finding also requires >=5.0.12).
- source-map-js via Sentry/webpack: https://github.com/advisories/GHSA-68fv-2mgg-jv7q (>=1.2.2).

## Remaining pilot blockers, in order

1. Independent checker reviews this local patch and reproduced fixture output. Public push requires owner approval; no PR is created here.
2. Triage and fix exposed dependency vulnerabilities; run complete type/lint/build/unit gates on a sufficiently sized machine, plus real DB/RLS/concurrency invariants.
3. Verify the official-channel account/number, app secret, token storage, webhook HTTPS and consent. Exercise real inbound -> default pipeline -> policy-approved manual reply and visually inspect the PT-BR browser flow. No spend without verified costs/approval.
4. Choose approved public name/configuration. Preserve upstream notices; verify deployment image and transitive licence inventory.
5. Establish one willing buyer, the precise paid pilot scope, current costs and cancellation/terms. Agree price/payment handling before commercial messaging or charging. No paid-pilot success inferred.

## Direct runtime metadata inventory

Source: package.json dependencies plus installed package.json files after frozen lockfile install, scripts disabled. Does not inventory all transitive packages or Docker binaries.

| Package                        | Installed version | Declared licence |
| ------------------------------ | ----------------- | ---------------- |
| @ai-sdk/anthropic              | 4.0.16            | Apache-2.0       |
| @ai-sdk/google                 | 4.0.18            | Apache-2.0       |
| @ai-sdk/openai                 | 4.0.78            | Apache-2.0       |
| @emoji-mart/data               | 1.2.1             | MIT              |
| @emoji-mart/react              | 1.1.1             | MIT              |
| @hello-pangea/dnd              | 18.0.1            | Apache-2.0       |
| @hookform/resolvers            | 5.9.1             | MIT              |
| @modelcontextprotocol/sdk      | 1.30.1            | MIT              |
| @phosphor-icons/react          | 2.1.10            | MIT              |
| @radix-ui/react-alert-dialog   | 1.1.23            | MIT              |
| @radix-ui/react-avatar         | 1.2.6             | MIT              |
| @radix-ui/react-dialog         | 1.1.23            | MIT              |
| @radix-ui/react-dropdown-menu  | 2.1.24            | MIT              |
| @radix-ui/react-label          | 2.1.15            | MIT              |
| @radix-ui/react-popover        | 1.1.23            | MIT              |
| @radix-ui/react-scroll-area    | 1.2.18            | MIT              |
| @radix-ui/react-select         | 2.3.7             | MIT              |
| @radix-ui/react-separator      | 1.1.15            | MIT              |
| @radix-ui/react-slot           | 1.3.3             | MIT              |
| @radix-ui/react-switch         | 1.3.7             | MIT              |
| @radix-ui/react-tabs           | 1.1.21            | MIT              |
| @radix-ui/react-tooltip        | 1.2.16            | MIT              |
| @react-pdf/renderer            | 4.9.0             | MIT              |
| @sentry/nextjs                 | 11.0.0            | MIT              |
| @supabase/ssr                  | 0.12.7            | MIT              |
| @supabase/supabase-js          | 2.117.2           | MIT              |
| @tanstack/react-query          | 5.104.0           | MIT              |
| @tanstack/react-query-devtools | 5.104.0           | MIT              |
| @tanstack/react-virtual        | 3.14.13           | MIT              |
| @upstash/redis                 | 1.39.0            | MIT              |
| @xyflow/react                  | 12.11.6           | MIT              |
| ai                             | 7.0.116           | Apache-2.0       |
| class-variance-authority       | 0.7.1             | Apache-2.0       |
| clsx                           | 2.1.1             | MIT              |
| date-fns                       | 4.4.0             | MIT              |
| fflate                         | 0.8.3             | MIT              |
| gpt-tokenizer                  | 4.0.0             | MIT              |
| import-in-the-middle           | 3.5.1             | Apache-2.0       |
| ipaddr.js                      | 2.5.0             | MIT              |
| jsonc-parser                   | 3.3.1             | MIT              |
| lucide-react                   | 1.48.0            | ISC              |
| next                           | 16.3.6            | MIT              |
| next-themes                    | 0.4.6             | MIT              |
| nodemailer                     | 10.0.10           | MIT-0            |
| pdfjs-dist                     | 6.3.289           | Apache-2.0       |
| pg                             | 8.23.0            | MIT              |
| qrcode                         | 1.5.4             | MIT              |
| react                          | 19.3.0            | MIT              |
| react-dom                      | 19.3.0            | MIT              |
| react-hook-form                | 7.88.0            | MIT              |
| react-hotkeys-hook             | 5.3.3             | MIT              |
| recharts                       | 3.10.1            | MIT              |
| require-in-the-middle          | 8.0.1             | MIT              |
| resend                         | 6.28.1            | MIT              |
| sonner                         | 2.0.8             | MIT              |
| tailwind-merge                 | 3.7.0             | MIT              |
| web-push                       | 3.6.7             | MPL-2.0          |
| ws                             | 8.21.3            | MIT              |
| zod                            | 4.6.5             | MIT              |
