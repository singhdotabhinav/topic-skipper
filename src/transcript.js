// Gets timed captions for the current YouTube video. Returns [{start, dur, text}] in seconds.
// Platform-specific code lives here so other sites can get their own fetcher later.
(function (root) {
  function extractJson(html, key) {
    const i = html.indexOf(`"${key}":`);
    if (i < 0) return null;
    let j = html.indexOf("[", i);
    let depth = 0, inStr = false, esc = false;
    for (let k = j; k < html.length; k++) {
      const ch = html[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) return JSON.parse(html.slice(j, k + 1));
    }
    return null;
  }

  function pickTrack(tracks) {
    const lang = (navigator.language || "en").slice(0, 2);
    const score = (t) => (t.kind !== "asr" ? 2 : 0) + (t.languageCode.startsWith(lang) ? 1 : 0);
    return [...tracks].sort((a, b) => score(b) - score(a))[0];
  }

  async function viaCaptionTracks(videoId) {
    const html = await (await fetch(`/watch?v=${videoId}`, { credentials: "include" })).text();
    const tracks = extractJson(html, "captionTracks");
    if (!tracks || !tracks.length) throw new Error("no caption tracks");
    const res = await fetch(pickTrack(tracks).baseUrl + "&fmt=json3", { credentials: "include" });
    const body = await res.text();
    if (!body) throw new Error("empty timedtext response");
    const json = JSON.parse(body);
    return json.events
      .filter((e) => e.segs)
      .map((e) => ({ start: e.tStartMs / 1000, dur: (e.dDurationMs || 0) / 1000, text: e.segs.map((s) => s.utf8).join("").replace(/\n/g, " ") }));
  }

  // Fallback: open YouTube's own transcript panel and read it.
  async function viaTranscriptPanel() {
    const sel = "ytd-transcript-segment-renderer";
    if (!document.querySelector(sel)) {
      const btn = [...document.querySelectorAll("ytd-video-description-transcript-section-renderer button, button")].find((b) =>
        /show transcript/i.test(b.textContent || b.getAttribute("aria-label") || "")
      );
      if (!btn) throw new Error("transcript button not found");
      btn.click();
      for (let i = 0; i < 20 && !document.querySelector(sel); i++) await new Promise((r) => setTimeout(r, 250));
    }
    const rows = [...document.querySelectorAll(sel)];
    if (!rows.length) throw new Error("transcript panel empty");
    return rows.map((r) => {
      const ts = r.querySelector(".segment-timestamp")?.textContent.trim() || "0:00";
      const start = ts.split(":").reduce((a, p) => a * 60 + Number(p), 0);
      return { start, dur: 0, text: r.querySelector(".segment-text")?.textContent.trim() || "" };
    });
  }

  async function fetchCues(videoId) {
    try {
      return await viaCaptionTracks(videoId);
    } catch (e) {
      console.debug("[topic-skipper] caption fetch failed, trying transcript panel:", e.message);
      return viaTranscriptPanel();
    }
  }

  root.TopicSkipperTranscript = { fetchCues };
})(globalThis);
