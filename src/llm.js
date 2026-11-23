// Stand-up comedy segmentation via Claude. Pure logic + one injectable fetch, so it runs in the
// extension's service worker and in node tests.
(function (root) {
  const DEFAULT_MODEL = "claude-haiku-5-5"; // cheapest current model; this job needs no deep reasoning
  const MAX_CHARS = 200000; // ~50k tokens per request, under Haiku's cheap-pricing tier
  const LINE_SEC = 6;

  const SYSTEM = `You split stand-up comedy transcripts into skippable bits so a viewer can jump from one bit to the next.

Input: lines like "[12:05] text" (auto-captions, may contain errors; [Laughter] / [Applause] markers may appear).
Output: the START timestamp of every bit, copied exactly from an input line.

A bit is ONE of:
- a single self-contained joke,
- one whole story, however long: multiple punchlines, callbacks, tangents and tags all stay inside the same bit until the comedian clearly moves to something unrelated,
- one crowd-work exchange with one audience member, until the comedian moves to a different person or goes back to prepared material.

Rules:
- Start a new bit only where the comedian clearly moves to a new joke, a new story, or a different audience member. Never split inside a bit.
- A follow-up punchline on the same premise belongs to the same bit.
- Do not group or relate bits to each other.
- Greetings/intro and goodbyes/outro may be their own bits with kind "other".
- Timestamps must be ascending. Titles: at most 6 words, describing the bit (for crowd work, name the person if said).`;

  const SCHEMA = {
    type: "object",
    properties: {
      bits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "string" },
            title: { type: "string" },
            kind: { type: "string", enum: ["joke", "story", "crowd_work", "other"] },
          },
          required: ["start", "title", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["bits"],
    additionalProperties: false,
  };

  const pad = (n) => String(n).padStart(2, "0");
  function fmtTime(s) {
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
  function parseTime(str) {
    const parts = String(str).trim().replace(/[\[\]]/g, "").split(":").map(Number);
    if (!parts.length || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return NaN;
    return parts.reduce((a, p) => a * 60 + p, 0);
  }

  // Merge cues into ~6s lines to keep token count low.
  function buildTranscript(cues) {
    const lines = [];
    let start = null, buf = [];
    const flush = () => { if (buf.length) lines.push(`[${fmtTime(start)}] ${buf.join(" ")}`); buf = []; start = null; };
    for (const c of [...cues].sort((a, b) => a.start - b.start)) {
      const text = c.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (start !== null && c.start - start >= LINE_SEC) flush();
      if (start === null) start = c.start;
      buf.push(text);
    }
    flush();
    return lines.join("\n");
  }

  function chunkCues(cues, maxChars = MAX_CHARS) {
    const chunks = [];
    let cur = [], size = 0;
    for (const c of cues) {
      if (size + c.text.length > maxChars && cur.length) { chunks.push(cur); cur = []; size = 0; }
      cur.push(c);
      size += c.text.length + 10;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  async function callApi(transcript, { apiKey, model, fetchImpl }) {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000, // thinking tokens count toward this too
        system: SYSTEM,
        messages: [{ role: "user", content: transcript }],
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message || "request failed"}`);
    if (body.stop_reason === "refusal") throw new Error("model refused the request");
    if (body.stop_reason === "max_tokens") throw new Error("response cut off (max_tokens)");
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text);
    return { bits: parsed.bits || [], usage: body.usage };
  }

  // bits: [{start:"m:ss", title, kind}] -> [{start, end, label, kind}] covering [0, duration]
  function toSegments(bits, duration) {
    const sorted = bits
      .map((b) => ({ start: parseTime(b.start), title: (b.title || "").trim(), kind: b.kind }))
      .filter((b) => Number.isFinite(b.start) && b.start >= 0 && b.start < duration)
      .sort((a, b) => a.start - b.start);
    const kept = [];
    for (const b of sorted) {
      if (kept.length && b.start - kept[kept.length - 1].start < 10) continue; // model double-listed a boundary
      kept.push(b);
    }
    if (!kept.length) return [];
    kept[0].start = 0; // anything before the first listed bit belongs to it
    return kept.map((b, i) => ({ start: b.start, end: i + 1 < kept.length ? kept[i + 1].start : duration, label: b.title, kind: b.kind }));
  }

  async function analyze(cues, duration, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
    if (!apiKey) throw new Error("no_key");
    const bits = [];
    let inTokens = 0, outTokens = 0;
    for (const chunk of chunkCues(cues)) {
      const r = await callApi(buildTranscript(chunk), { apiKey, model, fetchImpl });
      bits.push(...r.bits);
      inTokens += r.usage?.input_tokens || 0;
      outTokens += r.usage?.output_tokens || 0;
    }
    return { segments: toSegments(bits, duration), usage: { inTokens, outTokens } };
  }

  const api = { analyze, buildTranscript, chunkCues, toSegments, parseTime, fmtTime, DEFAULT_MODEL, SYSTEM, SCHEMA };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TopicSkipperLlm = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
