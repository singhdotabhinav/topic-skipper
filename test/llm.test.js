const assert = require("assert");
const { analyze, buildTranscript, chunkCues, toSegments, parseTime } = require("../src/llm");

assert.strictEqual(parseTime("12:05"), 725);
assert.strictEqual(parseTime("1:02:03"), 3723);
assert(Number.isNaN(parseTime("abc")));

// transcript: ~6s lines, timestamps formatted
const cues = [];
for (let t = 0; t < 130; t += 2) cues.push({ start: t, dur: 2, text: `line ${t}` });
const tr = buildTranscript(cues);
assert(tr.startsWith("[0:00] line 0 line 2 line 4"), tr.slice(0, 60));
assert(tr.includes("[2:06]"));

// segments: first forced to 0, near-duplicate dropped, out-of-range dropped, end chained
const segs = toSegments(
  [
    { start: "0:40", title: "Airport joke", kind: "joke" },
    { start: "0:44", title: "dupe", kind: "joke" },
    { start: "1:30", title: "Dad story", kind: "story" },
    { start: "9:99:99", title: "garbage", kind: "other" },
    { start: "50:00", title: "past end", kind: "other" },
  ],
  130
);
assert.deepStrictEqual(segs.map((s) => [s.start, s.end, s.label]), [[0, 90, "Airport joke"], [90, 130, "Dad story"]]);

// chunking splits long input without losing cues
const big = Array.from({ length: 10 }, (_, i) => ({ start: i, dur: 1, text: "x".repeat(100) }));
const chunks = chunkCues(big, 350);
assert(chunks.length > 1 && chunks.flat().length === 10);

(async () => {
  // stubbed API: verify request shape and response handling
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ bits: [{ start: "0:00", title: "Intro", kind: "other" }, { start: "1:30", title: "Dad story", kind: "story" }] }) }],
        usage: { input_tokens: 500, output_tokens: 40 },
      }),
    };
  };
  const r = await analyze(cues, 130, { apiKey: "test-key", fetchImpl });
  assert.strictEqual(seen.url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(seen.init.headers["x-api-key"], "test-key");
  assert.strictEqual(seen.body.model, "claude-haiku-5-5");
  assert.strictEqual(seen.body.output_config.effort, "low");
  assert.strictEqual(seen.body.output_config.format.type, "json_schema");
  assert(!("temperature" in seen.body) && !("thinking" in seen.body));
  assert.strictEqual(r.segments.length, 2);
  assert.deepStrictEqual(r.usage, { inTokens: 500, outTokens: 40 });

  await assert.rejects(analyze(cues, 130, { apiKey: "", fetchImpl }), /no_key/);
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid x-api-key" } }) });
  await assert.rejects(analyze(cues, 130, { apiKey: "k", fetchImpl: bad }), /401: invalid x-api-key/);
  const refused = async () => ({ ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) });
  await assert.rejects(analyze(cues, 130, { apiKey: "k", fetchImpl: refused }), /refused/);
  console.log("ok");
})();
