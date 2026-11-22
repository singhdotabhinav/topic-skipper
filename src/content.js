(function () {
  const { segment } = window.TopicSkipperSegment;
  const { fetchCues } = window.TopicSkipperTranscript;

  let cues = null, segments = [], currentVideo = null, root = null;
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem("topicSkipper." + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem("topicSkipper." + k, JSON.stringify(v)); } catch {} },
  };

  const videoEl = () => document.querySelector("video.html5-main-video");
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  function currentIndex(t) {
    let idx = 0;
    segments.forEach((s, i) => { if (t >= s.start) idx = i; });
    return idx;
  }

  function next() {
    const v = videoEl();
    const s = segments.find((s) => s.start > v.currentTime + 0.5);
    if (s) v.currentTime = s.start;
  }

  function prev() {
    const v = videoEl();
    const i = currentIndex(v.currentTime);
    v.currentTime = v.currentTime - segments[i].start > 3 || i === 0 ? segments[i].start : segments[i - 1].start;
  }

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

  function recompute() {
    const v = videoEl();
    const res = segment(cues, { duration: v.duration, sensitivity: store.get("sens", 0.5) });
    segments = res.segments;
    root.querySelector(".ts-status").textContent = `${segments.length} parts` + (res.laughCount ? ` · ${res.laughCount} laughs` : "");
    renderList();
    renderMarkers();
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
        <label>Split more finely <input class="ts-sens" type="range" min="0" max="1" step="0.05"></label>
        <div class="ts-status"></div>
        <div class="ts-list"></div>
      </div>`;
    player.appendChild(root);
    root.querySelector(".ts-prev").onclick = prev;
    root.querySelector(".ts-next").onclick = next;
    root.querySelector(".ts-toggle").onclick = () => { const p = root.querySelector(".ts-panel"); p.hidden = !p.hidden; };
    const sens = root.querySelector(".ts-sens");
    sens.value = store.get("sens", 0.5);
    sens.onchange = () => { store.set("sens", Number(sens.value)); recompute(); };
    // stop YouTube hotkeys/clicks from reacting to our panel
    root.addEventListener("keydown", (e) => e.stopPropagation());
  }

  function tick() {
    const v = videoEl();
    if (!root || !segments.length || !v) return;
    const i = currentIndex(v.currentTime);
    root.querySelector(".ts-now").textContent = `${i + 1}/${segments.length} · ${segments[i].label || ""}`;
    root.querySelectorAll(".ts-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.i) === i));
  }

  async function init() {
    const id = new URLSearchParams(location.search).get("v");
    if (location.pathname !== "/watch" || !id || id === currentVideo) return;
    currentVideo = id;
    cues = null; segments = [];
    document.getElementById("topic-skipper")?.remove();
    const player = await waitFor(() => document.getElementById("movie_player"));
    const v = await waitFor(() => { const e = videoEl(); return e && e.duration ? e : null; });
    if (currentVideo !== id) return;
    buildUi(player);
    try {
      cues = await fetchCues(id);
      if (currentVideo !== id) return;
      recompute();
      videoEl().addEventListener("timeupdate", tick);
    } catch (e) {
      root.querySelector(".ts-now").textContent = "no transcript available";
      console.warn("[topic-skipper]", e);
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
