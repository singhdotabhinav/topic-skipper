const assert = require("assert");
const { segment } = require("../src/segment");

const topics = [
  "politician election campaign voters rally senator speech policy ballot".split(" "),
  "women safety streets night police harassment protection crime report".split(" "),
  "cricket match bowler wicket stadium innings captain tournament score".split(" "),
];

// 3 topics x 150s, a cue every 5s; topic words repeat with some variation.
function make(topicWords, startT, len) {
  const cues = [];
  for (let t = startT; t < startT + len; t += 5) {
    const w = (i) => topicWords[(Math.floor(t / 5) + i * 3) % topicWords.length];
    cues.push({ start: t, dur: 5, text: `so the ${w(0)} thing is that ${w(1)} and ${w(2)} matter here` });
  }
  return cues;
}
const cues = [...make(topics[0], 0, 150), ...make(topics[1], 150, 150), ...make(topics[2], 300, 150)];

const { segments } = segment(cues, { duration: 450, sensitivity: 0.5 });
const starts = segments.map((s) => s.start);
console.log("topic segments:", segments.map((s) => `${s.start}-${s.end} [${s.label}]`));
for (const expected of [150, 300]) {
  assert(starts.some((s) => Math.abs(s - expected) <= 16), `expected a boundary near ${expected}, got ${starts}`);
}

// Laughter: boundary right after each laugh burst.
const comedy = [];
for (let t = 0; t < 300; t += 5) {
  comedy.push({ start: t, dur: 5, text: t % 60 === 50 ? "[Laughter]" : `joke ${Math.floor(t / 60)} line ${t}` });
}
const r = segment(comedy, { duration: 300, sensitivity: 0.5 });
console.log("laugh segments:", r.segments.map((s) => `${s.start}-${s.end}`));
assert(r.laughCount === 5);
assert(r.segments.some((s) => s.start === 55 || s.start === 115), "expected boundary just after laughter");
console.log("ok");
