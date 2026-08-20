import { useEffect, useMemo, useState } from "react";

import type { CapabilityDevtoolsSnapshot } from "../../../src/devtools";

type Tab = "timeline" | "state" | "diff" | "protocol" | "runtime" | "authority";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function JsonTree({ value, name = "root" }: { value: Json; name?: string }) {
  if (value === null || typeof value !== "object") {
    return <span className="pit-json-value">{JSON.stringify(value)}</span>;
  }
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  return (
    <details className="pit-json-node" open={name === "root"}>
      <summary>{name} <span className="pit-muted">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span></summary>
      <div className="pit-json-children">
        {entries.map(([key, entry]) => (
          <div className="pit-json-row" key={key}>
            <span className="pit-json-key">{key}</span>
            {entry !== null && typeof entry === "object"
              ? <JsonTree value={entry as Json} name={key} />
              : <JsonTree value={entry as Json} />}
          </div>
        ))}
      </div>
    </details>
  );
}

interface DiffRow { path: string; before: Json | undefined; after: Json | undefined }

function diff(before: Json | undefined, after: Json | undefined, path = "state"): DiffRow[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before !== null && after !== null &&
    typeof before === "object" && typeof after === "object" &&
    !Array.isArray(before) && !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => diff(before[key], after[key], `${path}.${key}`));
  }
  return [{ path, before, after }];
}

function download(snapshot: CapabilityDevtoolsSnapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `paperclip-devtools-r${snapshot.currentRevision}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function DevtoolsInspector({ snapshot, onFork }: { snapshot: CapabilityDevtoolsSnapshot; onFork: (revision: number) => void }) {
  const [tab, setTab] = useState<Tab>("timeline");
  const [query, setQuery] = useState("");
  const latest = snapshot.revisions.at(-1)!;
  const [revision, setRevision] = useState(latest.revision);
  const [following, setFollowing] = useState(true);
  const [compareRevision, setCompareRevision] = useState(snapshot.revisions[0]!.revision);
  const selected = snapshot.revisions.find((entry) => entry.revision === revision) ?? latest;
  const compared = snapshot.revisions.find((entry) => entry.revision === compareRevision) ?? snapshot.revisions[0]!;
  const rows = useMemo(
    () => diff(compared.state as Json, selected.state as Json),
    [compared.state, selected.state],
  );
  const normalized = query.trim().toLowerCase();
  const revisions = snapshot.revisions.filter((entry) =>
    normalized.length === 0 || JSON.stringify(entry).toLowerCase().includes(normalized),
  );
  const protocol = snapshot.protocol.filter((entry) =>
    normalized.length === 0 || JSON.stringify(entry).toLowerCase().includes(normalized),
  );
  useEffect(() => {
    if (following) setRevision(latest.revision);
  }, [following, latest.revision]);

  return (
    <section className="pit-devtools" data-testid="devtools-inspector">
      <div className="pit-devtools-toolbar">
        <label className="pit-card-meta" htmlFor="devtools-search">Filter</label>
        <input id="devtools-search" className="pit-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="operation, entity, turn…" />
        <button className="pit-button" type="button" aria-pressed={!following} onClick={() => setFollowing((value) => !value)}>{following ? "Pause" : "Follow latest"}</button>
        <button className="pit-button" type="button" onClick={() => download(snapshot)}>Export</button>
        <button className="pit-button" type="button" onClick={() => onFork(revision)}>Fork r{revision}</button>
      </div>
      <div className="pit-devtools-tabs" role="tablist" aria-label="Developer tools">
        {(["timeline", "state", "diff", "protocol", "runtime", "authority"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="pit-tab" onClick={() => setTab(id)}>{id[0]!.toUpperCase() + id.slice(1)}</button>
        ))}
      </div>
      {tab === "timeline" ? (
        <div className="pit-devtools-list">
          {revisions.map((entry) => (
            <button type="button" className="pit-devtools-event" data-selected={entry.revision === revision} key={entry.revision} onClick={() => { setFollowing(false); setRevision(entry.revision); }}>
              <strong>r{entry.revision}</strong><span>{entry.operationId}</span><span className="pit-muted">{entry.turnId ?? "session"}</span>
            </button>
          ))}
        </div>
      ) : null}
      {tab === "state" ? (
        <div>
          <label className="pit-card-meta" htmlFor="devtools-revision">Revision</label>
          <select id="devtools-revision" className="pit-select" value={revision} onChange={(event) => setRevision(Number(event.target.value))}>
            {snapshot.revisions.map((entry) => <option key={entry.revision} value={entry.revision}>r{entry.revision} · {entry.operationId}</option>)}
          </select>
          <JsonTree value={selected.state as Json} />
        </div>
      ) : null}
      {tab === "diff" ? (
        <div>
          <div className="pit-button-row">
            <select className="pit-select" aria-label="Compare from revision" value={compareRevision} onChange={(event) => setCompareRevision(Number(event.target.value))}>
              {snapshot.revisions.map((entry) => <option key={entry.revision} value={entry.revision}>from r{entry.revision}</option>)}
            </select>
            <select className="pit-select" aria-label="Compare to revision" value={revision} onChange={(event) => setRevision(Number(event.target.value))}>
              {snapshot.revisions.map((entry) => <option key={entry.revision} value={entry.revision}>to r{entry.revision}</option>)}
            </select>
          </div>
          {rows.map((row) => <div className="pit-diff-row" key={row.path}><strong>{row.path}</strong><del>{JSON.stringify(row.before)}</del><ins>{JSON.stringify(row.after)}</ins></div>)}
          {rows.length === 0 ? <p className="pit-muted">No changes between these revisions.</p> : null}
        </div>
      ) : null}
      {tab === "protocol" ? <div className="pit-devtools-list">{protocol.map((entry) => <details className="pit-runner-event" key={entry.id}><summary><strong>{entry.boundary}</strong> · {entry.event}</summary><JsonTree value={entry.detail as Json} /></details>)}</div> : null}
      {tab === "runtime" ? <JsonTree value={snapshot.runtime as Json} /> : null}
      {tab === "authority" ? <JsonTree value={snapshot.authority as Json} /> : null}
    </section>
  );
}
