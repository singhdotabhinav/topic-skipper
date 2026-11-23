(function () {
  const { segment } = window.TopicSkipperSegment;
  const { fetchCues } = window.TopicSkipperTranscript;
  const Llm = window.TopicSkipperLlm; // pure helpers only; the API call happens in the background worker
  const Log = window.TopicSkipperLog;
  const log = Log.createLogger("content");

  const WINDOW_SEC = 300; // transcript sent to the AI per request
  const PREFETCH_SEC = 120; // load the next window when the player is this close to the edge of what's analysed
  const MAX_SKIP_WINDOWS = 8; // while skipping an unfinished story, give up after this many extensions
  const RETRY_MS = 15000;

  let cues = null, segments = [], currentVideo = null, root = null;
  let mode = "basic"; // "ai": lazy windowed Claude analysis; "basic": local algorithm over the whole transcript
  let state = null; // ai mode: {bits, lo, hi}, known bits for [lo, hi)
  let inflight = null, retryAfter = 0, lastError = "", provider = "anthropic", unsubscribeLog = null;

  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem("topicSkipper." + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem("topicSkipper." + k, JSON.stringify(v)); } catch {} },
  };

  const videoEl = () => document.querySelector("video.html5-main-video");
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const cacheKey = () => `seg2:${provider}:${currentVideo}`; // local-model splits are rougher, so cache them apart

  function currentIndex(t) {
    let idx = 0;
    segments.forEach((s, i) => { if (t >= s.start) idx = i; });
    return idx;
  }

  // ---- AI windows -------------------------------------------------------------------------------

  async function persist() {
    try { await chrome.storage.local.set({ [cacheKey()]: state }); } catch {}
  }

  // Analyse the next window, restarting at the unfinished last bit so a long story is judged as a whole.
  function extend() {
    if (inflight) return inflight;
    const duration = videoEl().duration;
    if (state.hi >= duration) return Promise.resolve();
    const id = currentVideo;
    const { from, to } = Llm.nextWindow(state, duration, WINDOW_SEC);
    const windowCues = cues.filter((c) => c.start >= from && c.start < to);
    const t0 = Date.now();
    log("window:request", { from, to, cues: windowCues.length, restartsAtOpenBit: state.bits.length > 0, stateBefore: { lo: state.lo, hi: state.hi, bits: state.bits.length } });
    inflight = (async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: "window", cues: windowCues, from, to });
        Log.ingest(r?.trace); // lines produced in the background worker (request/response bodies, timings)
        log("window:response", { ms: Date.now() - t0, error: r?.error, bits: r?.bits?.length, usage: r?.usage });
        if (r?.error) throw new Error(r.error);
        if (id !== currentVideo) { log("window:discarded", "video changed while waiting"); return; }
        state = Llm.mergeWindow(state, from, to, r.bits);
        lastError = "";
        log("state:merged", { lo: state.lo, hi: state.hi, bits: state.bits.map((b) => `${fmt(b.start)} ${b.kind} ${b.title}`) });
        persist();
      } catch (e) {
        log("window:error", e.message);
        throw e;
      } finally {
        inflight = null;
        refresh();
      }
    })();
    refresh(); // show the busy state
    return inflight;
  }

  function ensureAhead() {
    if (mode !== "ai" || !state || inflight || Date.now() < retryAfter) return;
    const v = videoEl();
    if (state.hi < v.duration && v.currentTime > state.hi - PREFETCH_SEC) {
      log("prefetch:trigger", { t: +v.currentTime.toFixed(1), hi: state.hi, secondsToEdge: +(state.hi - v.currentTime).toFixed(1), threshold: PREFETCH_SEC });
      extend().catch((e) => { lastError = e.message; retryAfter = Date.now() + RETRY_MS; refresh(); });
    }
  }

  // Seeked outside what we've analysed: start a fresh window from there.
  function onSeeked() {
    if (mode !== "ai" || !state) return;
    const t = videoEl().currentTime;
    const inside = t >= state.lo && t <= state.hi;
    log("seek", { t: +t.toFixed(1), lo: state.lo, hi: state.hi, action: inside ? "inside analysed range, nothing to do" : "outside range, starting a fresh window" });
    if (inside) return;
    const lo = Math.max(0, t - 30);
    state = { bits: [], lo, hi: lo };
    refresh();
    ensureAhead();
  }

  // ---- navigation -------------------------------------------------------------------------------

  async function next() {
    const v = videoEl();
    const find = () => segments.find((s) => s.start > v.currentTime + 0.5);
    let s = find();
    log("nav:next", { t: +v.currentTime.toFixed(1), knownTarget: s ? fmt(s.start) : null });
    // inside a bit that may still be running (a long story): keep loading until its end shows up
    for (let i = 0; !s && mode === "ai" && state && state.hi < v.duration && i < MAX_SKIP_WINDOWS; i++) {
      log("nav:next:extending", { attempt: i + 1, max: MAX_SKIP_WINDOWS, hi: state.hi });
      try { await extend(); } catch (e) { lastError = e.message; retryAfter = Date.now() + RETRY_MS; refresh(); break; }
      s = find();
    }
    log("nav:next:result", { target: s ? fmt(s.start) : null, label: s?.label });
    if (s) v.currentTime = s.start;
  }

  function prev() {
    const v = videoEl();
    if (!segments.length) return;
    const i = currentIndex(v.currentTime);
    const target = v.currentTime - segments[i].start > 3 || i === 0 ? segments[i].start : segments[i - 1].start;
    log("nav:prev", { t: +v.currentTime.toFixed(1), target: fmt(target) });
    v.currentTime = target;
  }

  // ---- UI ---------------------------------------------------------------------------------------

  function renderMarkers() {
    const bar = document.querySelector(".ytp-progress-bar");
    const v = videoEl();
    if (!bar || !v?.duration) return;
    bar.querySelectorAll(".ts-tick").forEach((n) => n.remove());
    for (const s of segments.slice(1)) {
      const tick = document.createElement("div");
      tick.className = "ts-tick";
      tick.style.left = (s.start / v.duration) * 100 + "%";
      bar.appendChild(tick);
    }
  }

  function renderList() {
    const list = root.querySelector(".ts-list");
    list.innerHTML = "";
    segments.forEach((s, i) => {
      const row = document.createElement("button");
      row.className = "ts-row";
      row.dataset.i = i;
      row.textContent = `${fmt(s.start)}  ${s.label || "(no text)"}`;
      row.onclick = () => { videoEl().currentTime = s.start; };
      list.appendChild(row);
    });
  }

  function statusText() {
    if (mode !== "ai") return root.dataset.basicStatus || "";
    const parts = [`${segments.length} bits (${provider === "ollama" ? "local" : "AI"})`, `analysed to ${fmt(state.hi)}`];
    if (inflight) parts.push("loading…");
    if (lastError) parts.push(`error: ${lastError}`);
    return parts.join(" · ");
  }

  // Rebuild everything derived from the current state.
  function refresh() {
    if (!root) return;
    const v = videoEl();
    segments = mode === "ai" ? Llm.toSegments(state, v.duration) : segments;
    root.querySelector(".ts-sens-row").hidden = mode === "ai"; // slider only applies to the basic splitter
    root.querySelector(".ts-status").textContent = statusText();
    renderList();
    renderMarkers();
    tick(false);
  }

  // Playback tracking: log segment changes immediately and the distance to the analysed edge every 10 s.
  let lastIndex = -1, lastTrack = 0;
  function trackLog(v, i) {
    if (i !== lastIndex) {
      lastIndex = i;
      log("track:segment", { t: +v.currentTime.toFixed(1), index: i, of: segments.length, start: fmt(segments[i].start), label: segments[i].label, open: !!segments[i].open });
    }
    if (Date.now() - lastTrack > 10000) {
      lastTrack = Date.now();
      log("track:position", { t: +v.currentTime.toFixed(1), mode, hi: state?.hi, secondsToEdge: state ? +(state.hi - v.currentTime).toFixed(1) : null, inflight: !!inflight });
    }
  }

  function tick(prefetch = true) {
    const v = videoEl();
    if (!root || !v) return;
    if (prefetch) ensureAhead();
    if (!segments.length) {
      if (inflight) root.querySelector(".ts-now").textContent = "AI is splitting…";
      return;
    }
    const i = currentIndex(v.currentTime);
    if (prefetch) trackLog(v, i);
    root.querySelector(".ts-now").textContent = `${i + 1}/${segments.length}${segments[i].open ? "+" : ""} · ${segments[i].label || ""}${inflight ? " ⏳" : ""}`;
    root.querySelectorAll(".ts-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.i) === i));
  }

  function buildUi(player) {
    root = document.createElement("div");
    root.id = "topic-skipper";
    root.innerHTML = `
      <div class="ts-bar">
        <button class="ts-prev" title="Previous part  [">⏮</button>
        <button class="ts-next" title="Next part  ]">⏭</button>
        <span class="ts-now">loading…</span>
        <button class="ts-toggle" title="Show parts">☰</button>
      </div>
      <div class="ts-panel" hidden>
        <label class="ts-sens-row">Split more finely <input class="ts-sens" type="range" min="0" max="1" step="0.05"></label>
        <div class="ts-status"></div>
        <div class="ts-list"></div>
        <details class="ts-logs">
          <summary>Logs</summary>
          <button class="ts-copylog">Copy all</button>
          <pre class="ts-log"></pre>
        </details>
      </div>`;
    player.appendChild(root);
    root.querySelector(".ts-prev").onclick = prev;
    root.querySelector(".ts-next").onclick = next;
    root.querySelector(".ts-toggle").onclick = () => { const p = root.querySelector(".ts-panel"); p.hidden = !p.hidden; };
    const sens = root.querySelector(".ts-sens");
    sens.value = store.get("sens", 0.5);
    sens.onchange = () => { store.set("sens", Number(sens.value)); basicSplit(); };
    root.addEventListener("keydown", (e) => e.stopPropagation()); // keep YouTube hotkeys out of our panel
    const pre = root.querySelector(".ts-log");
    Log.lines().slice(-150).forEach((l) => (pre.textContent += Log.format(l).slice(0, 400) + "\n"));
    unsubscribeLog?.();
    unsubscribeLog = Log.subscribe((l) => {
      pre.textContent += Log.format(l).slice(0, 400) + "\n";
      if (pre.textContent.length > 60000) pre.textContent = pre.textContent.slice(-40000);
      pre.scrollTop = pre.scrollHeight;
    });
    root.querySelector(".ts-copylog").onclick = () => navigator.clipboard.writeText(Log.lines().map(Log.format).join("\n"));
  }

  // ---- startup ----------------------------------------------------------------------------------

  // Local algorithm (no API key, or AI unavailable). Instant, covers the whole video.
  function basicSplit(note = root?.dataset.basicNote || "") {
    mode = "basic";
    root.dataset.basicNote = note;
    const res = segment(cues, { duration: videoEl().duration, sensitivity: store.get("sens", 0.5) });
    segments = res.segments;
    root.dataset.basicStatus = `${segments.length} parts (basic split)` + (res.laughCount ? ` · ${res.laughCount} laughs` : "") + note;
    refresh();
  }

  async function startAi() {
    const v = videoEl();
    const t = v.currentTime;
    const cached = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
    if (cached && t >= cached.lo && t <= cached.hi) state = cached;
    else { const lo = Math.max(0, t - 30); state = { bits: [], lo, hi: lo }; }
    log("cache", { key: cacheKey(), hit: state === cached, startAt: +t.toFixed(1), lo: state.lo, hi: state.hi, bits: state.bits.length });
    mode = "ai";
    refresh();
    if (!state.bits.length || t > state.hi - PREFETCH_SEC) await extend(); // throws if the very first call fails
  }

  async function init() {
    const id = new URLSearchParams(location.search).get("v");
    if (location.pathname !== "/watch" || !id || id === currentVideo) return;
    currentVideo = id;
    cues = null; segments = []; state = null; inflight = null; lastError = ""; mode = "basic"; lastIndex = -1;
    log("init", { videoId: id, url: location.href });
    document.getElementById("topic-skipper")?.remove();
    const player = await waitFor(() => document.getElementById("movie_player"));
    const v = await waitFor(() => { const e = videoEl(); return e && e.duration ? e : null; });
    if (currentVideo !== id || !v) return;
    buildUi(player);
    if (!v.dataset.tsBound) { // the <video> element is reused across navigations; bind once
      v.dataset.tsBound = "1";
      v.addEventListener("timeupdate", () => tick());
      v.addEventListener("seeked", onSeeked);
    }
    try {
      cues = await fetchCues(id);
      if (currentVideo !== id) return;
      log("transcript:ready", { cues: cues.length, first: cues[0], last: cues[cues.length - 1], videoDuration: v.duration });
    } catch (e) {
      log("transcript:failed", e.message);
      root.querySelector(".ts-now").textContent = "no transcript available";
      console.warn("[topic-skipper]", e);
      return;
    }
    const cfg = await chrome.storage.local.get(["apiKey", "provider"]);
    provider = cfg.provider === "ollama" ? "ollama" : "anthropic";
    log("config", { provider, apiKey: cfg.apiKey ? "set" : "not set" });
    if (provider === "anthropic" && !cfg.apiKey) return basicSplit(" · add an API key (or pick Ollama) in the extension options for AI splitting");
    try {
      await startAi();
    } catch (e) {
      if (currentVideo !== id) return;
      log("ai:unavailable", e.message);
      basicSplit(` · AI failed: ${e.message}`);
    }
  }

  function waitFor(fn, tries = 60) {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        const r = fn();
        if (r || --tries <= 0) { clearInterval(t); resolve(r); }
      }, 250);
    });
  }

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!segments.length) return;
    if (e.key === "]") next();
    else if (e.key === "[") prev();
  });

  window.addEventListener("yt-navigate-finish", init);
  init();
})();
