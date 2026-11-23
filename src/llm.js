// Stand-up comedy segmentation via Claude. Pure logic + one injectable fetch, so it runs in the
// extension's service worker and in node tests.
(function (root) {
  const DEFAULT_MODEL = "claude-haiku-5-5"; // cheapest current model; this job needs no deep reasoning
  const DEFAULT_OLLAMA_MODEL = "llama3.1:8b"; // for free local testing; weaker than Haiku, expect rougher splits
  const DEFAULT_OLLAMA_URL = "http://localhost:11434";
  const LINE_SEC = 6;

  const SYSTEM = `You split stand-up comedy transcripts into skippable bits so a viewer can jump from one bit to the next.

Input: an excerpt of a longer show, as lines like "[12:05] text" (auto-captions, may contain errors; [Laughter] / [Applause] markers may appear). The excerpt may begin in the middle of a show and may end in the middle of a bit: still list that last, unfinished bit.
Output: the START timestamp of every bit, copied exactly from an input line. The first bit starts at the first line.

A bit is ONE of:
- a single self-contained joke,
- one whole story, however long: multiple punchlines, callbacks, tangents and tags all stay inside the same bit until the comedian clearly moves to something unrelated,
- one crowd-work exchange with one audience member, until the comedian moves to a different person or goes back to prepared material.

Rules:
- Prefer FEWER, longer bits. If in doubt, do NOT split. A joke is typically 20-90 seconds; a story or a crowd-work exchange is typically 2-8 minutes.
- Start a new bit only where the comedian clearly moves to a new joke, a new story, or a different audience member. Never split inside a bit.
- Inside a story, new scenes, "and then..." beats, callbacks and extra punchlines are NOT new bits. The story is one bit until the comedian leaves it for something unrelated.
- Inside crowd work, follow-up questions and jokes about the SAME person (job, spouse, hobbies) are NOT new bits. A new bit starts only when the comedian turns to a different person or goes back to prepared material.
- A follow-up punchline on the same premise belongs to the same bit.
- Do not group or relate bits to each other.
- Greetings/intro and goodbyes/outro may be their own bits with kind "other".
- Timestamps must be ascending. Titles: at most 6 words, describing the bit (for crowd work, name the person if said).

Example (a story with several beats, then crowd work with one person, then another person):
[0:10] my dad refused to ask for directions
[0:40] we ended up in another state
[1:20] and my mom whispered ask someone
[2:00] he finally asked a gas station guy
[2:30] okay you in the blue shirt what's your name
[2:40] Priya I'm a dentist
[3:10] married? five years
[3:50] you in the hat, name?
[4:00] Raj I sell insurance
Correct bits: 0:10 story "Dad refuses directions" / 2:30 crowd_work "Priya the dentist" / 3:50 crowd_work "Raj, insurance". The story's beats at 0:40, 1:20, 2:00 and Priya's follow-ups at 2:40, 3:10 are NOT separate bits.`;

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

  async function callAnthropic(transcript, { apiKey, model, fetchImpl }) {
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

  // Local model via Ollama (no tokens spent). Needs OLLAMA_ORIGINS to allow the extension, see README.
  async function callOllama(transcript, { model, ollamaUrl, fetchImpl }) {
    const url = `${ollamaUrl.replace(/\/+$/, "")}/api/chat`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: transcript }],
          format: SCHEMA, // constrains output to the JSON schema
          options: { temperature: 0, num_ctx: 8192 }, // default context is too small for a 5-minute window
        }),
      });
    } catch {
      throw new Error(`can't reach Ollama at ${ollamaUrl}: is it running?`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('Ollama blocked the extension: start it with OLLAMA_ORIGINS="chrome-extension://*"');
    if (res.status === 404) throw new Error(`Ollama has no model "${model}": run "ollama pull ${model}"`);
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${body?.error || "request failed"}`);
    const parsed = JSON.parse(body.message?.content || "{}");
    return { bits: parsed.bits || [], usage: { input_tokens: body.prompt_eval_count, output_tokens: body.eval_count } };
  }

  // Raw model bits -> clean, ascending bits inside [from, to); first bit pinned to `from`.
  function normalizeBits(bits, from, to) {
    const sorted = bits
      .map((b) => ({ start: parseTime(b.start), title: (b.title || "").trim(), kind: b.kind }))
      .filter((b) => Number.isFinite(b.start) && b.start >= from && b.start < to)
      .sort((a, b) => a.start - b.start);
    const kept = [];
    for (const b of sorted) {
      if (kept.length && b.start - kept[kept.length - 1].start < 15) continue; // model double-listed a boundary
      kept.push(b);
    }
    // small models over-split: adjacent bits with the same kind and title are one bit
    const merged = kept.filter((b, i) => !(i && b.kind === kept[i - 1].kind && b.title.toLowerCase() === kept[i - 1].title.toLowerCase()));
    if (merged.length) merged[0].start = from;
    return merged;
  }

  // Analyse one window of the transcript: cues with start in [from, to).
  // opts: {provider: "anthropic" | "ollama", apiKey, model, ollamaUrl, fetchImpl}
  async function analyzeWindow(cues, { from, to }, opts) {
    const { provider = "anthropic", apiKey, fetchImpl = fetch } = opts;
    if (provider === "anthropic" && !apiKey) throw new Error("no_key");
    const inWindow = cues.filter((c) => c.start >= from && c.start < to);
    if (!inWindow.length) return { bits: [], usage: { inTokens: 0, outTokens: 0 } };
    const transcript = buildTranscript(inWindow);
    const r =
      provider === "ollama"
        ? await callOllama(transcript, { model: opts.model || DEFAULT_OLLAMA_MODEL, ollamaUrl: opts.ollamaUrl || DEFAULT_OLLAMA_URL, fetchImpl })
        : await callAnthropic(transcript, { apiKey, model: opts.model || DEFAULT_MODEL, fetchImpl });
    return {
      bits: normalizeBits(r.bits, from, to),
      usage: { inTokens: r.usage?.input_tokens || 0, outTokens: r.usage?.output_tokens || 0 },
    };
  }

  // state = {bits, lo, hi}: bits known for [lo, hi). A new window starts at the last (possibly unfinished)
  // bit, so its result replaces that bit and everything after it.
  function mergeWindow(state, from, to, bits) {
    return { lo: state.lo, hi: to, bits: state.bits.filter((b) => b.start < from).concat(bits) };
  }

  // The window to analyse next: restart at the unfinished last bit and grow forward by `step`.
  function nextWindow(state, duration, step) {
    const last = state.bits[state.bits.length - 1];
    return { from: last ? last.start : state.lo, to: Math.min(duration, state.hi + step) };
  }

  function toSegments(state, duration) {
    const edge = Math.min(state.hi, duration);
    return state.bits.map((b, i) => ({
      start: b.start,
      end: i + 1 < state.bits.length ? state.bits[i + 1].start : edge,
      label: b.title,
      kind: b.kind,
      open: i === state.bits.length - 1 && state.hi < duration, // may still continue past `hi`
    }));
  }

  const api = { analyzeWindow, buildTranscript, normalizeBits, mergeWindow, nextWindow, toSegments, parseTime, fmtTime, DEFAULT_MODEL, DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, SYSTEM, SCHEMA };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TopicSkipperLlm = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
