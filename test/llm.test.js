const assert = require("assert");
const { analyzeWindow, buildTranscript, normalizeBits, mergeWindow, nextWindow, toSegments, parseTime } = require("../src/llm");

assert.strictEqual(parseTime("12:05"), 725);
assert.strictEqual(parseTime("1:02:03"), 3723);
assert(Number.isNaN(parseTime("abc")));

const cues = [];
for (let t = 0; t < 1000; t += 2) cues.push({ start: t, dur: 2, text: `line ${t}` });

// transcript lines are ~6s, absolute timestamps
const tr = buildTranscript(cues.filter((c) => c.start >= 120 && c.start < 140));
assert(tr.startsWith("[2:00] line 120 line 122 line 124"), tr);

// normalizeBits: window-bounded, near-duplicates dropped, first pinned to `from`
const nb = normalizeBits(
  [
    { start: "5:05", title: "Story", kind: "story" },
    { start: "5:09", title: "dupe", kind: "story" },
    { start: "9:30", title: "outside window", kind: "joke" },
    { start: "zzz", title: "garbage", kind: "other" },
  ],
  300,
  480
);
assert.deepStrictEqual(nb.map((b) => [b.start, b.title]), [[300, "Story"]]);

// small models over-split: same kind + same title back to back is one bit; near-duplicate starts collapse
const om = normalizeBits(
  [
    { start: "1:10", title: "Dad story", kind: "story" },
    { start: "2:10", title: "dad story", kind: "story" },
    { start: "4:10", title: "Priya", kind: "crowd_work" },
    { start: "4:22", title: "Priya: dentist", kind: "crowd_work" }, // 12s after previous: double-listed boundary
    { start: "5:45", title: "Raj", kind: "crowd_work" },
  ],
  0,
  480
);
assert.deepStrictEqual(om.map((b) => [b.start, b.title]), [[0, "Dad story"], [250, "Priya"], [345, "Raj"]]);

// --- windowing: a story that runs past the first window --------------------------------------
const D = 1000;
let state = { bits: [], lo: 0, hi: 0 };

// window 1: [0, 300). Model sees a joke at 0 and a story starting at 4:10 that is cut off at 5:00.
let w = nextWindow(state, D, 300);
assert.deepStrictEqual(w, { from: 0, to: 300 });
state = mergeWindow(state, w.from, w.to, [
  { start: 0, title: "Joke 1", kind: "joke" },
  { start: 250, title: "Dad story", kind: "story" },
]);
let segs = toSegments(state, D);
assert.deepStrictEqual(segs.map((s) => [s.start, s.end, s.open]), [[0, 250, false], [250, 300, true]]);

// window 2 restarts at the unfinished story (250) and grows to 600: the story is still going, ends at 8:20
w = nextWindow(state, D, 300);
assert.deepStrictEqual(w, { from: 250, to: 600 });
state = mergeWindow(state, w.from, w.to, [
  { start: 250, title: "Dad story", kind: "story" },
  { start: 500, title: "Airport joke", kind: "joke" },
]);
segs = toSegments(state, D);
assert.deepStrictEqual(segs.map((s) => [s.start, s.end, s.open]), [[0, 250, false], [250, 500, false], [500, 600, true]]);

// last window is clamped to the video length and closes the final bit
state = { ...state, hi: 900 };
w = nextWindow(state, D, 300);
assert.strictEqual(w.to, D);
state = mergeWindow(state, w.from, w.to, [{ start: 500, title: "Airport joke", kind: "joke" }]);
assert.strictEqual(toSegments(state, D).at(-1).open, false);

(async () => {
  // stubbed API: request shape, window slicing, response handling
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ bits: [{ start: "5:00", title: "Intro", kind: "other" }, { start: "7:30", title: "Dad story", kind: "story" }] }) }],
        usage: { input_tokens: 500, output_tokens: 40 },
      }),
    };
  };
  const r = await analyzeWindow(cues, { from: 300, to: 600 }, { apiKey: "test-key", fetchImpl });
  assert.strictEqual(seen.url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(seen.init.headers["x-api-key"], "test-key");
  assert.strictEqual(seen.body.model, "claude-haiku-5-5");
  assert.strictEqual(seen.body.output_config.effort, "low");
  assert.strictEqual(seen.body.output_config.format.type, "json_schema");
  assert(!("temperature" in seen.body) && !("thinking" in seen.body));
  const sent = seen.body.messages[0].content;
  assert(sent.startsWith("[5:00]") && !sent.includes("line 298") && !sent.includes("line 600"), "only the window is sent");
  assert.deepStrictEqual(r.bits.map((b) => b.start), [300, 450]);
  assert.deepStrictEqual(r.usage, { inTokens: 500, outTokens: 40 });

  // ollama: no key needed, local endpoint, schema-constrained, deterministic
  let o;
  const ollamaFetch = async (url, init) => {
    o = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ bits: [{ start: "5:00", title: "Local bit", kind: "joke" }] }) }, prompt_eval_count: 900, eval_count: 30 }) };
  };
  const lr = await analyzeWindow(cues, { from: 300, to: 600 }, { provider: "ollama", fetchImpl: ollamaFetch });
  assert.strictEqual(o.url, "http://localhost:11434/api/chat");
  assert.strictEqual(o.body.model, "llama3.1:8b");
  assert.strictEqual(o.body.stream, false);
  assert.strictEqual(o.body.options.temperature, 0);
  assert(o.body.options.num_ctx >= 8192);
  assert.strictEqual(o.body.format.type, "object");
  assert.strictEqual(o.body.messages[0].role, "system");
  assert.deepStrictEqual(lr.bits.map((b) => [b.start, b.title]), [[300, "Local bit"]]);
  assert.deepStrictEqual(lr.usage, { inTokens: 900, outTokens: 30 });
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(analyzeWindow(cues, { from: 0, to: 300 }, { provider: "ollama", fetchImpl: down }), /can't reach Ollama/);
  const forbidden = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(analyzeWindow(cues, { from: 0, to: 300 }, { provider: "ollama", fetchImpl: forbidden }), /OLLAMA_ORIGINS/);
  const noModel = async () => ({ ok: false, status: 404, json: async () => ({ error: "model not found" }) });
  await assert.rejects(analyzeWindow(cues, { from: 0, to: 300 }, { provider: "ollama", model: "x:1b", fetchImpl: noModel }), /ollama pull x:1b/);

  await assert.rejects(analyzeWindow(cues, { from: 0, to: 300 }, { apiKey: "", fetchImpl }), /no_key/);
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid x-api-key" } }) });
  await assert.rejects(analyzeWindow(cues, { from: 0, to: 300 }, { apiKey: "k", fetchImpl: bad }), /401: invalid x-api-key/);
  const refused = async () => ({ ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) });
  await assert.rejects(analyzeWindow(cues, { from: 0, to: 300 }, { apiKey: "k", fetchImpl: refused }), /refused/);
  console.log("ok");
})();
