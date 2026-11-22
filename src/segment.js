// Splits a transcript into topic / joke segments. Pure logic, no DOM, so it can be unit tested in node.
// Two signals are combined:
//   1. Topic shifts: TextTiling-style vocabulary similarity between the text before and after each gap.
//   2. Laughter/applause markers in captions ([Laughter]): the end of a laugh burst is a likely joke boundary.
(function (root) {
  const STOP = new Set(
    ("a an the and or but if then so of to in on at for with as by from is are was were be been being it its this that " +
      "these those i you he she we they me him her us them my your his our their not no do does did done have has had " +
      "will would can could should just like really very about what which who when where how there here also than too " +
      "up out into over more some any got get going gonna know think said say yeah okay oh um uh right one them").split(" ")
  );
  const LAUGH_RE = /\[\s*(laughter|laughing|laughs|applause|cheering|cheers|audience[^\]]*)\s*\]|\((laughter|laughs|applause)\)/gi;
  const ANY_MARKER_RE = /\[[^\]]*\]|♪[^♪]*♪/g;

  const BLOCK_SEC = 8;

  function tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9À-￿'\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^'+|'+$/g, "").replace(/(ing|ed|es|s)$/, ""))
      .filter((w) => w.length > 2 && !STOP.has(w));
  }

  // cues: [{start, dur, text}] in seconds. Returns cleaned cues and laughter timestamps.
  function prepare(cues) {
    const clean = [];
    const laughs = [];
    for (const c of cues) {
      const hasLaugh = LAUGH_RE.test(c.text);
      LAUGH_RE.lastIndex = 0;
      if (hasLaugh) laughs.push(c.start);
      const text = c.text.replace(ANY_MARKER_RE, " ").replace(/\s+/g, " ").trim();
      if (text) clean.push({ start: c.start, dur: c.dur, text });
    }
    return { clean, laughs };
  }

  function buildBlocks(clean, duration) {
    const n = Math.max(1, Math.ceil(duration / BLOCK_SEC));
    const blocks = Array.from({ length: n }, (_, i) => ({ start: i * BLOCK_SEC, tf: new Map() }));
    for (const c of clean) {
      const b = blocks[Math.min(n - 1, Math.floor(c.start / BLOCK_SEC))];
      for (const t of tokenize(c.text)) b.tf.set(t, (b.tf.get(t) || 0) + 1);
    }
    return blocks;
  }

  function sumWindow(blocks, from, to) {
    const tf = new Map();
    for (let i = Math.max(0, from); i < Math.min(blocks.length, to); i++) {
      for (const [t, v] of blocks[i].tf) tf.set(t, (tf.get(t) || 0) + v);
    }
    return tf;
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const [t, v] of a) {
      na += v * v;
      const w = b.get(t);
      if (w) dot += v * w;
    }
    for (const v of b.values()) nb += v * v;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  // Candidate topic boundaries as [{t, strength}] (strength = depth score, higher = clearer shift).
  function topicBoundaries(blocks, sensitivity) {
    const k = 5; // compare 40s of text on each side of a gap
    const gaps = blocks.length - 1;
    if (gaps < 2 * k) return [];
    const sim = [];
    for (let i = 0; i < gaps; i++) {
      sim.push(cosine(sumWindow(blocks, i - k + 1, i + 1), sumWindow(blocks, i + 1, i + 1 + k)));
    }
    const depth = sim.map((s, i) => {
      let l = i;
      while (l > 0 && sim[l - 1] >= sim[l]) l--;
      let r = i;
      while (r < gaps - 1 && sim[r + 1] >= sim[r]) r++;
      return sim[l] - s + (sim[r] - s);
    });
    const mean = depth.reduce((a, b) => a + b, 0) / depth.length;
    const sd = Math.sqrt(depth.reduce((a, b) => a + (b - mean) ** 2, 0) / depth.length);
    const thr = mean + (1.0 - 1.5 * sensitivity) * sd;
    const out = [];
    for (let i = 0; i < gaps; i++) {
      if (depth[i] > thr && depth[i] >= (depth[i - 1] ?? 0) && depth[i] >= (depth[i + 1] ?? 0)) {
        out.push({ t: blocks[i + 1].start, strength: depth[i] });
      }
    }
    return out;
  }

  // A joke usually ends in a burst of laughter; the next cue after the burst starts something new.
  function laughBoundaries(clean, laughs) {
    if (laughs.length < 3) return [];
    const out = [];
    let i = 0;
    while (i < laughs.length) {
      let end = laughs[i];
      while (i + 1 < laughs.length && laughs[i + 1] - end < 8) end = laughs[++i];
      const next = clean.find((c) => c.start > end + 2);
      if (next) out.push({ t: next.start, strength: 100 });
      i++;
    }
    return out;
  }

  function pickBoundaries(cands, minLen, duration) {
    const chosen = [];
    for (const c of [...cands].sort((a, b) => b.strength - a.strength)) {
      if (c.t < minLen || c.t > duration - minLen) continue;
      if (chosen.every((x) => Math.abs(x - c.t) >= minLen)) chosen.push(c.t);
    }
    return chosen.sort((a, b) => a - b);
  }

  function label(blocks, from, to, df, nBlocks) {
    const tf = sumWindow(blocks, Math.floor(from / BLOCK_SEC), Math.ceil(to / BLOCK_SEC));
    const scored = [...tf].map(([t, v]) => [t, v * Math.log(nBlocks / (1 + (df.get(t) || 0)))]);
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, 3).map((x) => x[0]).join(" · ");
  }

  // opts: {duration, sensitivity 0..1 (higher = more segments), minLen seconds}
  function segment(cues, opts) {
    const sensitivity = opts.sensitivity ?? 0.5;
    const minLen = opts.minLen ?? 25;
    const duration = opts.duration || (cues.length ? cues[cues.length - 1].start + 5 : 0);
    const { clean, laughs } = prepare(cues);
    const blocks = buildBlocks(clean, duration);
    const df = new Map();
    for (const b of blocks) for (const t of b.tf.keys()) df.set(t, (df.get(t) || 0) + 1);

    const cands = topicBoundaries(blocks, sensitivity).concat(laughBoundaries(clean, laughs));
    const bounds = [0, ...pickBoundaries(cands, minLen, duration), duration];
    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      segments.push({ start: bounds[i], end: bounds[i + 1], label: label(blocks, bounds[i], bounds[i + 1], df, blocks.length) });
    }
    return { segments, laughCount: laughs.length };
  }

  const api = { segment, prepare, tokenize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TopicSkipperSegment = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
