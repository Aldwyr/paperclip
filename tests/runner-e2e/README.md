# Paid runner full-stack E2E

This is the billable browser acceptance suite for Paperclip runner profiles. It
is deliberately separate from `tests/e2e`: every profile/environment cell gets
a fresh Paperclip home, embedded Postgres database, instance configuration,
port, workspace, company, encrypted secrets, environment, and agent.

The browser creates and assigns the task. The harness does not call a private
runner hook or write fixtures directly to the database.

## Credentials

Copy `.env.runner-e2e.example` to `.env.runner-e2e.local` and fill only the
credentials needed by the selected cells:

```bash
cp .env.runner-e2e.example .env.runner-e2e.local
chmod 600 .env.runner-e2e.local
```

Shell variables take precedence over the local file. The recognized names are:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `DAYTONA_API_KEY`
- `PAPERCLIP_E2E_DAYTONA_IMAGE` (Daytona only)

The image must be an immutable `image@sha256:...` reference. The launcher
reports missing variable names but never prints values. It passes raw provider
keys only to Playwright, which posts each value once to the company-secrets API.
Paperclip receives secret references in agent/environment payloads. Provider
keys, Daytona keys, `DATABASE_URL`, and `DATABASE_MIGRATION_URL` are removed
from the Paperclip child process.

Never put credentials in `catalog.ts`, screenshots, fixture metadata, workflow
inputs, or a tracked env file.

## Local commands

Install dependencies and Chromium once. Native local cells also need the local
runner binaries:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm --filter @paperclipai/paperclip-runner build:runner-binaries
```

List cells without loading credentials or starting Paperclip:

```bash
pnpm test:e2e:runner -- --list
```

Examples of explicit billable runs:

```bash
pnpm test:e2e:runner -- --id legacy-codex.local.message-marker --headed
pnpm test:e2e:runner -- --group native --environment local
pnpm test:e2e:runner -- --profile runner-codex --case message-marker
pnpm test:e2e:runner -- --case plan-revise-accept --group local
pnpm test:e2e:runner -- --case ask-question --group native
pnpm test:e2e:runner -- --all
```

The catalog contains three cases for every profile/environment pair:

- `message-marker`: one basic visible response and Done transition;
- `plan-revise-accept`: an initial Plan, a browser-requested revision on the
  same Plan, browser acceptance of the new revision, and verified execution;
- `ask-question`: a direct answer from a task created in Ask mode.

The full matrix is 48 executions. The plan case has three agent turns, so a
complete campaign performs 80 paid turns. Narrow selectors are strongly
recommended while developing fixtures.

`--group`, `--profile`, `--environment`, and `--case` are repeatable. Repeated
values in one dimension use OR semantics; dimensions and repeated groups use
AND semantics. `--id` is exclusive with dimension selectors and `--all`.
`--headed`, `--ui`, and `--debug` are forwarded to Playwright. An unknown
selector, an empty selection, or a run with no explicit selector exits before
Paperclip starts. `--max-parallel <n>` controls the number of isolated
profile/environment/case harnesses that can overlap (default 1, also configurable
with `PAPERCLIP_E2E_MAX_PARALLEL`). Headed/UI/debug runs are forced to one worker.
The Plan case is still sequential internally because its turns share one task;
it runs in parallel with unrelated scenarios.

Use a single `--id` smoke test for routine local verification. Full-matrix
parallelism is intended for GitHub Actions; raising local parallelism starts
multiple Paperclip/Postgres/Chromium stacks and can consume substantial CPU and
memory.

Credential-free checks are:

```bash
pnpm test:e2e:runner:unit
pnpm test:e2e:runner:typecheck
```

## Daytona image

Use the immutable digest printed by the `Publish verified Daytona image` job,
or publish the current source locally:

```bash
image="ghcr.io/paperclipai/paperclip-daytona-runner:e2e-git-$(git rev-parse HEAD)"
docker buildx build \
  --platform linux/amd64 \
  --build-arg "PAPERCLIP_RUNNER_SOURCE_REVISION=$(git rev-parse HEAD)" \
  --file docker/daytona-runner/Dockerfile \
  --tag "$image" \
  --push \
  .
docker buildx imagetools inspect "$image"
```

Resolve the manifest digest and set `PAPERCLIP_E2E_DAYTONA_IMAGE` to
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:...`. The repository
workflow signs that digest with Cosign/OIDC and verifies that it is publicly
pullable, includes the provider pack, and advertises `dial_ws_loopback`,
`dial_wss`, and `listen_ws`. The GHCR package must be configured as public;
the image job deliberately fails its anonymous-pull check otherwise.

## Evidence and cleanup

Safe evidence is written beneath `tests/runner-e2e/results/<campaign>/...`.
Passing attempts include `final-state.png`, Plan draft/revision screenshots when
applicable, matcher outcomes, sanitized fixture/API metadata, a result record,
JUnit, HTML, and a blob report. Failures additionally retain the
Playwright trace/video, browser diagnostics, failure screenshot, and sanitized
Paperclip/run logs when produced.

Every completed local campaign also writes
`tests/runner-e2e/results/<campaign>/dashboard.html`. The self-contained page
shows the complete profile/environment grid with screenshot thumbnails.
Expanding a case shows its matchers, pass/fail details, provider/model/runtime,
timings, usage, and evidence links. The CI report job stages the same portable
site at `normalized/index.html` inside the merged report artifact.

Before publication, the launcher:

1. copies only allowlisted file types;
2. scans raw API snapshots before sanitizing them;
3. scans the closed Paperclip home/database and workspace as streams;
4. redacts loaded exact values and known provider-key shapes from text;
5. expands ZIP reports for secret scanning;
6. rejects unsafe files and fails the cell if a leak is detected; and
7. verifies that a passing attempt has its final-state screenshot.

The temporary Paperclip home, embedded database, raw workspace, master key,
and unredacted logs are removed after each attempt. Daytona teardown destroys
the environment and any reusable leases through the public API; provider-side
auto-stop/archive/delete values remain as cancellation backstops.

## GitHub Actions

`Runner Full-Stack E2E` has only `schedule` and `workflow_dispatch` triggers; it
never runs for a pull request or ordinary push. Configure these repository
secrets with the exact names above. Manual inputs accept comma-separated values
for repeatable dimensions.

The nightly cron is `08:47 UTC`, but scheduled execution is intentionally gated
by the repository variable `RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED=true`. Set it
only after the live acceptance ladder in the architecture plan is green.
Artifacts and merged HTML/JUnit/normalized reports are retained for 30 days.

GitHub Actions artifacts are the private, durable audit copy and download as an
archive; they are not interactive web hosting. To publish the latest green
screenshot dashboard as a browsable site, enable GitHub Pages with GitHub
Actions as its source and set repository variable
`RUNNER_FULL_STACK_E2E_PUBLISH_PAGES=true`. The workflow uses its short-lived
`GITHUB_TOKEN`/OIDC permissions, so no S3 bucket or S3 token is required. Review
the repository's Pages visibility before enabling this because task prompts,
model output, and screenshots may be visible to site readers.

See [FIXTURES.md](./FIXTURES.md) before adding or changing a profile,
environment, task, matcher, or future Paperclip object fixture.
