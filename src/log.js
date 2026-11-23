// Shared logger: console + in-memory ring buffer + subscribers (the player's Logs panel, and the
// background worker's per-request trace that is sent back to the page).
(function (root) {
  const MAX = 500;
  const lines = [];
  const subs = new Set();

  const stamp = (t) => {
    const d = new Date(t);
    return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
  };

  function emit(line, mirror) {
    lines.push(line);
    if (lines.length > MAX) lines.shift();
    subs.forEach((f) => f(line));
    if (mirror || !line.mirrored) console.log(`[topic-skipper ${stamp(line.t)}] ${line.scope}:${line.event}`, line.data ?? "");
  }

  function createLogger(scope) {
    return (event, data) => emit({ t: Date.now(), scope, event, data }, true);
  }

  // Lines produced in another context (the background worker) and sent back with a response.
  function ingest(incoming) {
    for (const l of incoming || []) emit({ ...l, mirrored: true }, true);
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

  function format(line) {
    let d = "";
    try { d = line.data === undefined ? "" : " " + JSON.stringify(line.data); } catch { d = " [unserialisable]"; }
    return `${stamp(line.t)} ${line.scope}:${line.event}${d}`;
  }

  root.TopicSkipperLog = { createLogger, ingest, subscribe, format, lines: () => lines.slice() };
})(typeof globalThis !== "undefined" ? globalThis : this);
