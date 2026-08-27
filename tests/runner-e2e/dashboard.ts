import type { MatrixExecution, RunnerE2EResult } from "./types.js";

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
    (!availableFiles || availableFiles.has("failure.png"))
  ) {
    const href = safeEvidenceHref(entry.evidenceBaseHref, "failure.png");
    if (href)
      screenshots.push({
        id: "failure",
        label: "Failure state",
        file: "failure.png",
        href,
      });
  }
  const playwright = safeEvidenceHref(
    entry?.evidenceBaseHref,
    "html-report/index.html",
  );
  const links =
    screenshots.length > 0 || playwright
      ? `<nav aria-label="Evidence for ${html(execution.id)}">
          ${screenshots.map((item) => `<a href="${html(item.href)}">${html(item.label)}</a>`).join("")}
          ${playwright ? `<a href="${html(playwright)}">Playwright report</a>` : ""}
        </nav>`
      : "";
  const matcherRows = (entry?.result.matcherResults ?? [])
    .map(
      (result) => `<tr class="matcher-${result.passed ? "passed" : "failed"}">
        <td>${result.passed ? "✓" : "✕"}</td>
        <td><code>${html(result.matcher.kind)}</code></td>
        <td>${html(compactJson(result.matcher))}</td>
        <td>${html(result.detail)}</td>
      </tr>`,
    )
    .join("");
  const gallery = screenshots.length
    ? `<div class="gallery">${screenshots
        .map(
          (item) => `<a href="${html(item.href)}" title="${html(item.label)}">
            <img src="${html(item.href)}" loading="lazy" alt="${html(item.label)} for ${html(execution.id)}">
            <span>${html(item.label)}</span>
          </a>`,
        )
        .join("")}</div>`
    : "";
  return `<article class="case case-${state}" data-execution-id="${html(execution.id)}">
    <div class="case-heading">
      <strong>${html(execution.task.label)}</strong>
      <span class="status">${html(label)}</span>
    </div>
    ${gallery}
    <code>${html(execution.id)}</code>
    <details class="case-context">
      <summary>Matchers and test context</summary>
    ${
      entry
        ? `<dl>
            <div><dt>Attempt</dt><dd>${entry.result.attempt}</dd></div>
            <div><dt>Duration</dt><dd>${html(durationLabel(entry.result.durationMs))}</dd></div>
            <div><dt>Runtime</dt><dd>${html(entry.result.runtimeMode)}</dd></div>
            <div><dt>Provider</dt><dd>${html(entry.result.provider)}</dd></div>
            <div><dt>Model</dt><dd>${html(entry.result.model)}</dd></div>
            ${entry.result.issueIdentifier ? `<div><dt>Issue</dt><dd>${html(entry.result.issueIdentifier)}</dd></div>` : ""}
          </dl>`
        : ""
    }
    <p class="detail">${html(detail)}</p>
    ${matcherRows ? `<div class="matcher-wrap"><table class="matchers"><thead><tr><th>Pass</th><th>Matcher</th><th>Expectation</th><th>Detail</th></tr></thead><tbody>${matcherRows}</tbody></table></div>` : `<p class="detail">No matcher result was recorded.</p>`}
    ${entry?.result.usage ? `<details class="usage"><summary>Usage and cost metadata</summary><pre>${html(JSON.stringify(entry.result.usage, null, 2))}</pre></details>` : ""}
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
  const rows = profiles
    .map((profile) => {
      const columns = environments
        .map((environment) => {
          const executions = input.catalog.filter(
            (execution) =>
              execution.profile.id === profile.id &&
              execution.environment.id === environment.id,
          );
          return `<td>${executions
            .map((execution) => renderCase(execution, expected, entryById))
            .join("")}</td>`;
        })
        .join("");
      return `<tr>
        <th scope="row">
          <strong>${html(profile.label)}</strong>
          <span class="generation">${html(profile.generation)}</span>
          <small>${html(profile.provider)} · ${html(profile.model)}</small>
        </th>
        ${columns}
      </tr>`;
    })
    .join("");
  const environmentHeaders = environments
    .map(
      (environment) =>
        `<th scope="col"><strong>${html(environment.label)}</strong><small>${html(environment.provider)} · ${html(environment.expectedExecutionTarget.kind)}</small></th>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${html(input.title)}</title>
  <style>
    :root { color-scheme: dark; --bg: #0b1020; --panel: #131a2d; --line: #2a3554; --text: #eef2ff; --muted: #9aa8c7; --pass: #3ddc97; --fail: #ff6b81; --missing: #ffbd59; --idle: #69738c; }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top left, #18264a 0, var(--bg) 42rem); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1500px, calc(100% - 32px)); margin: 32px auto 64px; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
    h1 { margin: 0 0 4px; font-size: clamp(24px, 4vw, 42px); letter-spacing: -0.04em; }
    header p, small, .detail { color: var(--muted); }
    .summary { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .metric { min-width: 92px; padding: 10px 13px; border: 1px solid var(--line); border-radius: 12px; background: color-mix(in srgb, var(--panel) 88%, transparent); }
    .metric strong { display: block; font-size: 20px; }
    .metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 16px; background: color-mix(in srgb, var(--panel) 82%, transparent); box-shadow: 0 24px 80px #0006; }
    table { width: 100%; min-width: 960px; border-collapse: collapse; }
    th, td { padding: 14px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
    tr:last-child th, tr:last-child td { border-bottom: 0; }
    th:last-child, td:last-child { border-right: 0; }
    thead th { background: #11182a; }
    thead small, tbody th small { display: block; margin-top: 3px; font-weight: 400; }
    tbody th { width: 250px; background: #101729; }
    .generation { display: inline-block; margin-left: 7px; padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
    .case { min-height: 170px; padding: 13px; border: 1px solid var(--line); border-left-width: 4px; border-radius: 12px; background: #0e1527cc; }
    .case-passed { border-left-color: var(--pass); }
    .case-failed { border-left-color: var(--fail); }
    .case-missing { border-left-color: var(--missing); }
    .case-not-selected { border-left-color: var(--idle); opacity: .62; }
    .case-heading { display: flex; align-items: start; justify-content: space-between; gap: 10px; }
    .status { padding: 3px 8px; border-radius: 999px; background: #27314b; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .07em; }
    .case-passed .status { color: var(--pass); }
    .case-failed .status { color: var(--fail); }
    .case-missing .status { color: var(--missing); }
    code { display: block; margin: 9px 0; color: #bec9e7; font-size: 11px; overflow-wrap: anywhere; }
    dl { display: flex; flex-wrap: wrap; gap: 5px 14px; margin: 8px 0; }
    dl div { display: flex; gap: 5px; }
    dt { color: var(--muted); }
    dd { margin: 0; }
    .detail { margin: 10px 0; font-size: 12px; overflow-wrap: anywhere; }
    nav { display: flex; flex-wrap: wrap; gap: 10px; }
    a { color: #8bb8ff; font-size: 12px; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 12px 0; }
    .gallery a { display: block; text-decoration: none; }
    .gallery img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 8px; background: #080c16; }
    .gallery span { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; }
    .matcher-wrap { overflow-x: auto; margin: 10px 0; }
    .matchers { min-width: 650px; font-size: 11px; }
    .matchers th, .matchers td { padding: 7px; border: 1px solid var(--line); }
    .matchers .matcher-passed td:first-child { color: var(--pass); }
    .matchers .matcher-failed td:first-child { color: var(--fail); }
    .usage { margin: 10px 0; color: var(--muted); }
    .case-context > summary { cursor: pointer; color: #8bb8ff; font-size: 12px; }
    pre { max-height: 220px; overflow: auto; padding: 10px; border-radius: 8px; background: #080c16; color: #bec9e7; font-size: 10px; white-space: pre-wrap; }
    footer { margin-top: 14px; color: var(--muted); font-size: 12px; }
    @media (max-width: 760px) { header { align-items: start; flex-direction: column; } .summary { justify-content: start; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${html(input.title)}</h1>
        <p>Paid full-stack runner acceptance matrix</p>
      </div>
      <div class="summary" aria-label="Campaign summary">
        <div class="metric"><strong>${passed}/${input.expected.length}</strong><span>Passed</span></div>
        <div class="metric"><strong>${failed}</strong><span>Failed</span></div>
        <div class="metric"><strong>${html(durationLabel(totalDuration))}</strong><span>Test time</span></div>
      </div>
    </header>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Agent profile</th>${environmentHeaders}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <footer>Generated ${html(input.generatedAt)} · ${input.catalog.length} catalog executions · ${input.expected.length} selected</footer>
  </main>
</body>
</html>
`;
}
