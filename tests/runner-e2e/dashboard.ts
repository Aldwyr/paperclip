import type { MatrixExecution, RunnerE2EResult } from "./types.js";
import {
  aggregateCampaignBilling,
  summarizeExecutionBilling,
} from "./billing.js";

export interface RunnerDashboardEntry {
  result: RunnerE2EResult;
  valid: boolean;
  errors: readonly string[];
  evidenceBaseHref?: string;
  evidenceFiles?: readonly string[];
}

export interface RunnerDashboardInput {
  title: string;
  generatedAt: string;
  expected: readonly string[];
  catalog: readonly MatrixExecution[];
  entries: readonly RunnerDashboardEntry[];
}

interface ResolvedScreenshot {
  id: string;
  label: string;
  file: string;
  href: string;
}

function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function durationLabel(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function tokenLabel(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function usdLabel(value: number) {
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function safeEvidenceHref(base: string | undefined, relative: string) {
  if (!base || /^(?:[a-z]+:|\/\/)/i.test(base)) return null;
  const cleanBase = base
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
  const cleanRelative = relative
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
  return `${cleanBase}/${cleanRelative}`;
}

function compactJson(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized && serialized.length > 1_200
    ? `${serialized.slice(0, 1_200)}…`
    : serialized;
}

function resolveScreenshots(
  entry: RunnerDashboardEntry | undefined,
): ResolvedScreenshot[] {
  const declaredScreenshots = entry?.result.screenshots?.length
    ? entry.result.screenshots
    : entry
      ? [
          {
            id: "final-state",
            label: "Final visible task state",
            file: "final-state.png",
          },
        ]
      : [];
  const availableFiles = entry?.evidenceFiles
    ? new Set(entry.evidenceFiles)
    : null;
  const screenshots = declaredScreenshots
    .filter((item) => !availableFiles || availableFiles.has(item.file))
    .flatMap((item) => {
      const href = safeEvidenceHref(entry?.evidenceBaseHref, item.file);
      return href ? [{ ...item, href }] : [];
    });
  if (
    entry?.result.status === "failed" &&
    !screenshots.some((item) => item.file === "failure.png") &&
    (!availableFiles || availableFiles.has("failure.png"))
  ) {
    const href = safeEvidenceHref(entry.evidenceBaseHref, "failure.png");
    if (href) {
      screenshots.push({
        id: "failure",
        label: "Failure state",
        file: "failure.png",
        href,
      });
    }
  }
  return screenshots;
}

function renderCase(
  execution: MatrixExecution,
  expected: ReadonlySet<string>,
  entryById: ReadonlyMap<string, RunnerDashboardEntry>,
) {
  const selected = expected.has(execution.id);
  const entry = entryById.get(execution.id);
  const state = !selected
    ? "not-selected"
    : !entry
      ? "missing"
      : entry.valid
        ? "passed"
        : "failed";
  const label = state.replace("-", " ");
  const detail =
    entry?.errors.join("; ") ||
    (entry?.valid ? "All invariants passed" : "Not selected");
  const screenshots = resolveScreenshots(entry);
  const billing = entry ? summarizeExecutionBilling(entry.result) : null;
  const availableFiles = entry?.evidenceFiles
    ? new Set(entry.evidenceFiles)
    : null;
  const playwright =
    !availableFiles || availableFiles.has("html-report/index.html")
      ? safeEvidenceHref(entry?.evidenceBaseHref, "html-report/index.html")
      : null;
  const links =
    screenshots.length > 0 || playwright
      ? `<nav class="evidence-links" aria-label="Evidence for ${html(execution.id)}">
          ${screenshots.map((item) => `<a href="${html(item.href)}" target="_blank" rel="noreferrer">Open ${html(item.label.toLowerCase())}</a>`).join("")}
          ${playwright ? `<a href="${html(playwright)}">Open Playwright report</a>` : ""}
        </nav>`
      : "";
  const matcherRows = (entry?.result.matcherResults ?? [])
    .map(
      (result) => `<tr class="matcher-${result.passed ? "passed" : "failed"}">
        <td><span class="matcher-state" aria-label="${result.passed ? "Passed" : "Failed"}">${result.passed ? "Pass" : "Fail"}</span></td>
        <td><code>${html(result.matcher.kind)}</code></td>
        <td>${html(compactJson(result.matcher))}</td>
        <td>${html(result.detail)}</td>
      </tr>`,
    )
    .join("");
  const gallery = screenshots.length
    ? `<div class="gallery" aria-label="Screenshots for ${html(execution.id)}">${screenshots
        .map(
          (item) => `<button
            class="screenshot-trigger"
            type="button"
            data-gallery-item
            data-gallery-href="${html(item.href)}"
            data-gallery-label="${html(item.label)}"
            data-gallery-execution="${html(execution.id)}"
            aria-label="Open ${html(item.label)} for ${html(execution.id)} in gallery"
          >
            <span class="screenshot-frame"><img src="${html(item.href)}" loading="lazy" alt="${html(item.label)} for ${html(execution.id)}"></span>
            <span class="screenshot-caption"><span>${html(item.label)}</span><span aria-hidden="true">View</span></span>
          </button>`,
        )
        .join("")}</div>`
    : "";
  const billingStrip = billing
    ? `<div class="billing-strip" aria-label="Billing for ${html(execution.id)}">
        <div><span>Tokens</span><strong>${html(tokenLabel(billing.llm.inputTokens))} in · ${html(tokenLabel(billing.llm.outputTokens))} out</strong><small>${html(tokenLabel(billing.llm.cachedInputTokens))} cached · ${billing.llm.runsWithTokenUsage}/${billing.llm.runCount} runs covered</small></div>
        <div><span>LLM spend</span><strong>${billing.llm.runsWithReportedCost > 0 ? html(usdLabel(billing.reportedCostUsd)) : html(billing.llm.costStatus)}</strong><small>${billing.llm.runsWithReportedCost}/${billing.llm.runCount} runs provider-priced</small></div>
        <div><span>Execution</span><strong>${billing.runtime.estimatedListCostUsd === undefined ? html(billing.runtime.costStatus === "not_metered" ? "Local · not metered" : "Cost unavailable") : `${html(usdLabel(billing.runtime.estimatedListCostUsd))} est.`}</strong><small>${html(durationLabel(billing.runtime.agentRunDurationMs))} agent${billing.runtime.leaseDurationMs === null ? "" : ` · ${html(durationLabel(billing.runtime.leaseDurationMs))} lease`}</small></div>
      </div>`
    : "";
  return `<article class="case case-${state}" data-execution-id="${html(execution.id)}">
    <div class="case-heading">
      <strong>${html(execution.task.label)}</strong>
      <span class="status">${html(label)}</span>
    </div>
    ${gallery}
    ${billingStrip}
    <code class="execution-id">${html(execution.id)}</code>
    <details class="case-context">
      <summary>Matchers and test context</summary>
    ${
      entry
        ? `<dl>
            <div><dt>Attempt</dt><dd>${entry.result.attempt}</dd></div>
            <div><dt>Duration</dt><dd>${html(durationLabel(entry.result.durationMs))}</dd></div>
            <div><dt>Agent runtime</dt><dd>${html(durationLabel(billing!.runtime.agentRunDurationMs))}</dd></div>
            ${billing!.runtime.leaseDurationMs === null ? "" : `<div><dt>Environment lease</dt><dd>${html(durationLabel(billing!.runtime.leaseDurationMs))}</dd></div>`}
            <div><dt>Runtime</dt><dd>${html(entry.result.runtimeMode)}</dd></div>
            <div><dt>Provider</dt><dd>${html(entry.result.provider)}</dd></div>
            <div><dt>Model</dt><dd>${html(entry.result.model)}</dd></div>
            ${entry.result.issueIdentifier ? `<div><dt>Issue</dt><dd>${html(entry.result.issueIdentifier)}</dd></div>` : ""}
          </dl>`
        : ""
    }
    <p class="detail">${html(detail)}</p>
    ${matcherRows ? `<div class="matcher-wrap"><table class="matchers"><thead><tr><th>Result</th><th>Matcher</th><th>Expectation</th><th>Detail</th></tr></thead><tbody>${matcherRows}</tbody></table></div>` : `<p class="detail">No matcher result was recorded.</p>`}
    ${entry ? `<details class="usage"><summary>Usage and billing metadata</summary><pre>${html(JSON.stringify({ billing, rawUsage: entry.result.usage ?? null }, null, 2))}</pre></details>` : ""}
    ${links}
    </details>
  </article>`;
}

export function renderRunnerE2EDashboard(input: RunnerDashboardInput) {
  const expected = new Set(input.expected);
  const entryById = new Map(
    input.entries.map((entry) => [entry.result.executionId, entry]),
  );
  const profiles = [
    ...new Map(
      input.catalog.map((execution) => [
        execution.profile.id,
        execution.profile,
      ]),
    ).values(),
  ];
  const environments = [
    ...new Map(
      input.catalog.map((execution) => [
        execution.environment.id,
        execution.environment,
      ]),
    ).values(),
  ];
  const selectedEntries = input.entries.filter((entry) =>
    expected.has(entry.result.executionId),
  );
  const passed = selectedEntries.filter((entry) => entry.valid).length;
  const failed = input.expected.length - passed;
  const totalDuration = selectedEntries.reduce(
    (total, entry) => total + entry.result.durationMs,
    0,
  );
  const screenshotCount = selectedEntries.reduce(
    (total, entry) => total + resolveScreenshots(entry).length,
    0,
  );
  const campaignBilling = aggregateCampaignBilling(
    selectedEntries.map((entry) => entry.result),
  );
  const rows = profiles
    .map((profile, profileIndex) => {
      const columns = environments
        .map((environment) => {
          const executions = input.catalog.filter(
            (execution) =>
              execution.profile.id === profile.id &&
              execution.environment.id === environment.id,
          );
          return `<td><div class="case-stack">${executions
            .map((execution) => renderCase(execution, expected, entryById))
            .join("")}</div></td>`;
        })
        .join("");
      return `<tr>
        <th scope="row" class="profile-cell">
          <span class="agent-capsule agent-${(profileIndex % 10) + 1}" aria-hidden="true"></span>
          <span class="profile-copy">
            <span><strong>${html(profile.label)}</strong><span class="generation">${html(profile.generation)}</span></span>
            <small>${html(profile.provider)} · ${html(profile.model)}</small>
          </span>
        </th>
        ${columns}
      </tr>`;
    })
    .join("");
  const environmentHeaders = environments
    .map(
      (environment) =>
        `<th scope="col"><span class="environment-label">${html(environment.label)}</span><small>${html(environment.provider)} · ${html(environment.expectedExecutionTarget.kind)}</small></th>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#141413" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
  <title>${html(input.title)} · Paperclip</title>
  <style>
    @font-face { font-family: "Paperclip Inter"; src: url("assets/InterVariable.woff2") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; }
    :root {
      color-scheme: light dark;
      --background: #ffffff;
      --foreground: #0a0a0a;
      --card: #ffffff;
      --raised: #fafafa;
      --muted-foreground: #52585d;
      --quiet: #70767a;
      --border: #e5e5e5;
      --border-strong: #a8aeb2;
      --primary: #0a0a0a;
      --primary-foreground: #fafafa;
      --overlay: rgb(10 10 10 / 84%);
      --pass-bg: #dcfce7;
      --pass-text: #188a3c;
      --pass-border: #22c55e;
      --fail-bg: #fee2e2;
      --fail-text: #991b1b;
      --fail-border: #dc2626;
      --missing-bg: #fef3c7;
      --missing-text: #b45309;
      --missing-border: #f59e0b;
      --idle-bg: #f5f3f0;
      --idle-text: #52585d;
      --idle-border: #a8aeb2;
      --radius: 8px;
      --font-sans: "Paperclip Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #141413;
        --foreground: #fafafa;
        --card: #1c1c1b;
        --raised: #20201f;
        --muted-foreground: #a3a3a3;
        --quiet: #8c8c89;
        --border: rgb(255 255 255 / 10%);
        --border-strong: rgb(255 255 255 / 24%);
        --primary: #fafafa;
        --primary-foreground: #141413;
        --overlay: rgb(0 0 0 / 88%);
        --pass-bg: #22c55e1f;
        --pass-text: #34d06f;
        --pass-border: #22c55e73;
        --fail-bg: #dc26262e;
        --fail-text: #ef4444;
        --fail-border: #dc262673;
        --missing-bg: #f59e0b24;
        --missing-text: #f59e0b;
        --missing-border: #f59e0b73;
        --idle-bg: #6e696024;
        --idle-text: #9a958a;
        --idle-border: #9e958a73;
      }
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--background); color: var(--foreground); font: 14px/1.5 var(--font-sans); font-feature-settings: "ss01", "cv11"; }
    button, summary, a { -webkit-tap-highlight-color: transparent; }
    button, input, textarea, select { font: inherit; }
    a { color: inherit; text-underline-offset: 3px; }
    a:hover { text-decoration-thickness: 2px; }
    .brand-bar { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 0 max(24px, calc((100vw - 1560px) / 2)); border-bottom: 1px solid var(--border); }
    .brand-lockup { display: inline-flex; align-items: center; gap: 10px; color: var(--foreground); font-size: 16px; font-weight: 650; letter-spacing: -.02em; text-decoration: none; }
    .brand-lockup svg { width: 24px; height: 24px; flex: none; }
    .brand-context { color: var(--muted-foreground); font-size: 12px; }
    main { width: min(1560px, calc(100% - 48px)); margin: 48px auto 72px; }
    .report-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 40px; padding-bottom: 32px; }
    .eyebrow { margin: 0 0 12px; color: var(--muted-foreground); font: 500 11px/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
    h1 { max-width: 760px; margin: 0; font-size: clamp(32px, 4vw, 56px); font-weight: 650; line-height: 1.03; letter-spacing: -.04em; }
    .lede { max-width: 720px; margin: 16px 0 0; color: var(--muted-foreground); font-size: 16px; }
    .report-actions { display: flex; align-items: stretch; gap: 8px; }
    .summary { display: flex; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .metric { min-width: 108px; padding: 13px 16px; border-right: 1px solid var(--border); }
    .metric:last-child { border-right: 0; }
    .metric strong { display: block; font: 500 19px/1.2 var(--font-mono); font-variant-numeric: tabular-nums; }
    .metric span { display: block; margin-top: 4px; color: var(--muted-foreground); font-size: 11px; letter-spacing: .07em; text-transform: uppercase; }
    .gallery-launch, .gallery-control, .gallery-close { border: 1px solid var(--border-strong); border-radius: calc(var(--radius) * .8); background: var(--background); color: var(--foreground); cursor: pointer; font-weight: 600; transition: background 150ms ease, color 150ms ease, border-color 150ms ease; }
    .gallery-launch { min-width: 138px; padding: 10px 15px; }
    .gallery-launch:hover, .gallery-control:hover, .gallery-close:hover { border-color: var(--foreground); background: var(--primary); color: var(--primary-foreground); }
    .gallery-launch:focus-visible, .gallery-control:focus-visible, .gallery-close:focus-visible, .screenshot-trigger:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
    .table-kicker { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--border); color: var(--muted-foreground); }
    .table-kicker strong { color: var(--foreground); font-weight: 600; }
    .table-kicker span { font: 11px/1.4 var(--font-mono); font-variant-numeric: tabular-nums; }
    .table-wrap { overflow: auto; max-height: calc(100vh - 120px); border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .matrix { width: 100%; min-width: 1120px; border-collapse: separate; border-spacing: 0; }
    .matrix th, .matrix td { padding: 16px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); vertical-align: top; text-align: left; }
    .matrix tr:last-child th, .matrix tr:last-child td { border-bottom: 0; }
    .matrix th:last-child, .matrix td:last-child { border-right: 0; }
    .matrix thead th { position: sticky; top: 0; z-index: 4; background: var(--raised); }
    .matrix thead th:first-child { left: 0; z-index: 6; width: 260px; }
    .matrix thead small, .matrix tbody th small { display: block; margin-top: 4px; color: var(--muted-foreground); font-weight: 400; }
    .environment-label { font-size: 15px; font-weight: 650; }
    .profile-cell { position: sticky; left: 0; z-index: 3; width: 260px; background: var(--card); }
    .profile-cell { display: table-cell; }
    .profile-cell > .agent-capsule { float: left; margin: 2px 12px 18px 0; }
    .profile-copy { display: block; min-width: 0; }
    .profile-copy strong { font-size: 14px; }
    .profile-copy small { overflow-wrap: anywhere; }
    .agent-capsule { display: inline-block; width: 10px; height: 22px; border-radius: 999px; }
    .agent-1 { background: linear-gradient(to bottom, #f7cfdc, #1f7a3a); }
    .agent-2 { background: linear-gradient(to bottom, #c9a9e8, #ee79a1); }
    .agent-3 { background: linear-gradient(to bottom, #28164b, #7a1530); }
    .agent-4 { background: linear-gradient(to bottom, #f3e6c4, #e3a21a); }
    .agent-5 { background: linear-gradient(to bottom, #1f4dd6, #3aa35c); }
    .agent-6 { background: linear-gradient(to bottom, #e94b27, #5a1122); }
    .agent-7 { background: linear-gradient(to bottom, #7eb6e3, #ee79a1); }
    .agent-8 { background: linear-gradient(to bottom, #9ce8a7, #bd7ff0); }
    .agent-9 { background: linear-gradient(to bottom, #f3b49e, #1f4ed4); }
    .agent-10 { background: linear-gradient(to bottom, #f2d95f, #4fbcba); }
    .generation { display: inline-block; margin-left: 7px; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted-foreground); font: 500 10px/1.4 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
    .case-stack { display: grid; gap: 12px; }
    .case { min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .case-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .case-heading strong { font-size: 14px; font-weight: 650; }
    .status, .matcher-state { display: inline-block; flex: none; padding: 3px 8px; border: 1px solid; border-radius: 999px; font: 600 10px/1.4 var(--font-sans); letter-spacing: .05em; text-transform: uppercase; }
    .case-passed .status, .matcher-passed .matcher-state { border-color: var(--pass-border); background: var(--pass-bg); color: var(--pass-text); }
    .case-failed .status, .matcher-failed .matcher-state { border-color: var(--fail-border); background: var(--fail-bg); color: var(--fail-text); }
    .case-missing .status { border-color: var(--missing-border); background: var(--missing-bg); color: var(--missing-text); }
    .case-not-selected { opacity: .68; }
    .case-not-selected .status { border-color: var(--idle-border); background: var(--idle-bg); color: var(--idle-text); }
    code, pre, .execution-id { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .execution-id { display: block; margin: 10px 0; color: var(--muted-foreground); font-size: 11px; overflow-wrap: anywhere; }
    dl { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 12px 0; }
    dl div { display: flex; gap: 6px; }
    dt { color: var(--muted-foreground); }
    dd { margin: 0; font-family: var(--font-mono); font-size: 12px; }
    .detail { margin: 12px 0; color: var(--muted-foreground); font-size: 12px; overflow-wrap: anywhere; }
    .evidence-links { display: flex; flex-wrap: wrap; gap: 12px; padding-top: 4px; }
    .evidence-links a { color: var(--foreground); font-size: 12px; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 14px 0 10px; }
    .screenshot-trigger { min-width: 0; padding: 0; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); overflow: hidden; background: var(--background); color: var(--foreground); text-align: left; cursor: zoom-in; transition: border-color 150ms ease; }
    .screenshot-trigger:hover { border-color: var(--foreground); }
    .screenshot-frame { display: block; aspect-ratio: 16 / 10; overflow: hidden; border-bottom: 1px solid var(--border); background: #0a0a0a; }
    .screenshot-frame img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
    .screenshot-caption { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px; }
    .screenshot-caption span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); font-size: 10px; }
    .screenshot-caption span:last-child { font-size: 10px; font-weight: 650; }
    .matcher-wrap { overflow-x: auto; margin: 12px 0; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); }
    .matchers { width: 100%; min-width: 680px; border-collapse: collapse; font-size: 11px; }
    .matchers th, .matchers td { padding: 8px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); vertical-align: top; }
    .matchers tr:last-child td { border-bottom: 0; }
    .matchers th:last-child, .matchers td:last-child { border-right: 0; }
    .matchers th { background: var(--raised); color: var(--muted-foreground); font-weight: 600; }
    .matchers code { display: inline; color: var(--foreground); }
    .usage { margin: 12px 0; color: var(--muted-foreground); }
    .billing-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 12px 0 10px; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); background: var(--raised); }
    .billing-strip > div { min-width: 0; padding: 9px 10px; border-right: 1px solid var(--border); }
    .billing-strip > div:last-child { border-right: 0; }
    .billing-strip span, .billing-strip small { display: block; color: var(--muted-foreground); font-size: 9px; }
    .billing-strip span { letter-spacing: .06em; text-transform: uppercase; }
    .billing-strip strong { display: block; margin: 3px 0 1px; overflow-wrap: anywhere; font: 550 11px/1.35 var(--font-mono); font-variant-numeric: tabular-nums; }
    .billing-overview { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin: 0 0 32px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .billing-metric { min-width: 0; padding: 14px 16px; border-right: 1px solid var(--border); }
    .billing-metric:last-child { border-right: 0; }
    .billing-metric strong { display: block; overflow-wrap: anywhere; font: 550 17px/1.25 var(--font-mono); font-variant-numeric: tabular-nums; }
    .billing-metric span { display: block; margin-top: 4px; color: var(--muted-foreground); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .billing-note { grid-column: 1 / -1; margin: 0; padding: 11px 16px; border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: 11px; }
    .case-context > summary, .usage > summary { width: fit-content; cursor: pointer; color: var(--foreground); font-size: 12px; font-weight: 600; }
    pre { max-height: 240px; overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); background: var(--raised); color: var(--foreground); font-size: 10px; white-space: pre-wrap; }
    footer { display: flex; justify-content: space-between; gap: 16px; padding-top: 16px; color: var(--muted-foreground); font: 11px/1.4 var(--font-mono); }
    dialog.gallery-dialog { width: 100vw; max-width: none; height: 100dvh; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; color: #fafafa; }
    dialog.gallery-dialog::backdrop { background: var(--overlay); }
    .gallery-shell { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: 100%; height: 100%; background: var(--overlay); }
    .gallery-toolbar, .gallery-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-color: rgb(255 255 255 / 18%); }
    .gallery-toolbar { border-bottom: 1px solid rgb(255 255 255 / 18%); }
    .gallery-footer { border-top: 1px solid rgb(255 255 255 / 18%); }
    .gallery-meta { min-width: 0; }
    .gallery-meta strong, .gallery-meta span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gallery-meta strong { font-size: 14px; }
    .gallery-meta span { margin-top: 2px; color: #b8b8b5; font: 11px/1.4 var(--font-mono); }
    .gallery-close, .gallery-control { min-height: 38px; padding: 8px 12px; border-color: rgb(255 255 255 / 32%); background: transparent; color: #fafafa; }
    .gallery-stage { display: grid; place-items: center; min-height: 0; padding: 24px; overflow: hidden; touch-action: pan-y; }
    .gallery-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid rgb(255 255 255 / 18%); background: #0a0a0a; }
    .gallery-controls { display: flex; gap: 8px; }
    .gallery-position { color: #b8b8b5; font: 12px/1.4 var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 980px) {
      main { width: min(100% - 32px, 1560px); margin-top: 32px; }
      .report-header { grid-template-columns: 1fr; gap: 24px; }
      .report-actions { flex-wrap: wrap; }
      .billing-overview { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .billing-metric:nth-child(3) { border-right: 0; }
      .billing-metric:nth-child(-n+3) { border-bottom: 1px solid var(--border); }
      .table-wrap { max-height: none; }
    }
    @media (max-width: 640px) {
      .brand-bar { min-height: 56px; padding: 0 16px; }
      .brand-context { display: none; }
      main { width: min(100% - 24px, 1560px); margin-top: 28px; }
      .report-header { padding-bottom: 24px; }
      .report-actions { display: grid; }
      .summary { width: 100%; }
      .metric { min-width: 0; flex: 1; padding: 11px; }
      .metric strong { font-size: 16px; }
      .gallery-launch { width: 100%; }
      .billing-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .billing-metric, .billing-metric:nth-child(3) { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
      .billing-metric:nth-child(even) { border-right: 0; }
      .billing-strip { grid-template-columns: 1fr; }
      .billing-strip > div { border-right: 0; border-bottom: 1px solid var(--border); }
      .billing-strip > div:last-child { border-bottom: 0; }
      .gallery-toolbar, .gallery-footer { padding: 12px; }
      .gallery-stage { padding: 12px; }
      .gallery-footer { align-items: stretch; flex-direction: column; }
      .gallery-controls { display: grid; grid-template-columns: 1fr 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 100ms !important; }
    }
    @media print {
      .brand-bar, .gallery-launch, dialog { display: none; }
      main { width: 100%; margin: 0; }
      .table-wrap { max-height: none; overflow: visible; }
      .matrix thead th, .profile-cell { position: static; }
    }
  </style>
</head>
<body>
  <div class="brand-bar">
    <a class="brand-lockup" href="https://paperclip.ing" aria-label="Paperclip home">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>
      <span>Paperclip</span>
    </a>
    <span class="brand-context">Quality engineering · Runner acceptance</span>
  </div>
  <main>
    <header class="report-header">
      <div>
        <p class="eyebrow">Full-stack acceptance campaign</p>
        <h1>${html(input.title)}</h1>
        <p class="lede">A browser-verified matrix of runner profiles, execution environments, and deterministic task contracts. Every selected result includes visible final-state evidence.</p>
      </div>
      <div class="report-actions">
        <div class="summary" aria-label="Campaign summary">
          <div class="metric"><strong>${passed}/${input.expected.length}</strong><span>Passed</span></div>
          <div class="metric"><strong>${failed}</strong><span>Failed</span></div>
          <div class="metric"><strong>${html(durationLabel(totalDuration))}</strong><span>Test time</span></div>
        </div>
        <button class="gallery-launch" type="button" data-gallery-open ${screenshotCount === 0 ? "disabled" : ""}>View gallery · ${screenshotCount}</button>
      </div>
    </header>
    <section class="billing-overview" aria-label="Campaign billing summary">
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.inputTokens))}</strong><span>Input tokens</span></div>
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.outputTokens))}</strong><span>Output tokens</span></div>
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.cachedInputTokens))}</strong><span>Cached tokens</span></div>
      <div class="billing-metric"><strong>${html(usdLabel(campaignBilling.reportedLlmCostUsd))}</strong><span>LLM reported subtotal</span></div>
      <div class="billing-metric"><strong>${html(usdLabel(campaignBilling.estimatedRuntimeCostUsd))}</strong><span>Daytona list estimate</span></div>
      <div class="billing-metric"><strong>${campaignBilling.llm.runsWithReportedCost}/${campaignBilling.llm.runCount}</strong><span>Runs provider-priced</span></div>
      <p class="billing-note">Model spend is the provider-reported subtotal; unpriced or unavailable runs are excluded, never counted as free. Daytona runtime is a public-list-price estimate from captured lease time and pinned resources, before credits, discounts, storage allowance, or invoice adjustments. Local execution has no external runtime meter.</p>
    </section>
    <div class="table-kicker"><strong>Configuration matrix</strong><span>${profiles.length} profiles · ${environments.length} environments · ${input.expected.length} selected</span></div>
    <div class="table-wrap">
      <table class="matrix">
        <thead><tr><th scope="col">Agent profile</th>${environmentHeaders}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <footer><span>Generated ${html(input.generatedAt)}</span><span>${input.catalog.length} catalog executions</span></footer>
  </main>
  <dialog class="gallery-dialog" data-gallery-dialog aria-labelledby="gallery-title">
    <div class="gallery-shell">
      <div class="gallery-toolbar">
        <div class="gallery-meta">
          <strong id="gallery-title" data-gallery-title>Screenshot evidence</strong>
          <span data-gallery-execution></span>
        </div>
        <button class="gallery-close" type="button" data-gallery-close>Close</button>
      </div>
      <div class="gallery-stage" data-gallery-stage>
        <img data-gallery-image alt="">
      </div>
      <div class="gallery-footer">
        <span class="gallery-position" data-gallery-position aria-live="polite"></span>
        <div class="gallery-controls">
          <button class="gallery-control" type="button" data-gallery-previous>Previous</button>
          <button class="gallery-control" type="button" data-gallery-next>Next</button>
        </div>
      </div>
    </div>
  </dialog>
  <script>
    (() => {
      const dialog = document.querySelector("[data-gallery-dialog]");
      const items = Array.from(document.querySelectorAll("[data-gallery-item]"));
      if (!dialog || items.length === 0) return;
      const image = dialog.querySelector("[data-gallery-image]");
      const title = dialog.querySelector("[data-gallery-title]");
      const execution = dialog.querySelector("[data-gallery-execution]");
      const position = dialog.querySelector("[data-gallery-position]");
      const stage = dialog.querySelector("[data-gallery-stage]");
      let activeIndex = 0;
      let pointerStartX = null;

      const render = () => {
        const item = items[activeIndex];
        image.src = item.dataset.galleryHref;
        image.alt = item.dataset.galleryLabel + " for " + item.dataset.galleryExecution;
        title.textContent = item.dataset.galleryLabel;
        execution.textContent = item.dataset.galleryExecution;
        position.textContent = "Image " + (activeIndex + 1) + " of " + items.length;
      };
      const move = (amount) => {
        activeIndex = (activeIndex + amount + items.length) % items.length;
        render();
      };
      const open = (index) => {
        activeIndex = index;
        render();
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      };
      const close = () => {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      };

      items.forEach((item, index) => item.addEventListener("click", () => open(index)));
      document.querySelectorAll("[data-gallery-open]").forEach((button) => button.addEventListener("click", () => open(0)));
      dialog.querySelector("[data-gallery-previous]").addEventListener("click", () => move(-1));
      dialog.querySelector("[data-gallery-next]").addEventListener("click", () => move(1));
      dialog.querySelector("[data-gallery-close]").addEventListener("click", close);
      dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
        if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
      });
      stage.addEventListener("pointerdown", (event) => { pointerStartX = event.clientX; });
      stage.addEventListener("pointerup", (event) => {
        if (pointerStartX === null) return;
        const distance = event.clientX - pointerStartX;
        pointerStartX = null;
        if (Math.abs(distance) < 60) return;
        move(distance > 0 ? -1 : 1);
      });
      stage.addEventListener("pointercancel", () => { pointerStartX = null; });
    })();
  </script>
</body>
</html>
`;
}
