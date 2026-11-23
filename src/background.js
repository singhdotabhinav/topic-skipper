importScripts("log.js", "llm.js");

const log = TopicSkipperLog.createLogger("bg");

// Content scripts ask us to analyse one window of a transcript; the model call happens here so the
// API key never touches the page. Every response carries the log lines produced while handling it.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "window") return;
  const trace = [];
  const off = TopicSkipperLog.subscribe((l) => trace.push(l));
  run(msg)
    .then((r) => ({ ...r, trace }), (e) => { log("error", e.message); return { error: e.message, trace }; })
    .then((r) => { off(); sendResponse(r); });
  return true; // async response
});

async function run({ cues, from, to }) {
  const cfg = await chrome.storage.local.get(["provider", "apiKey", "model", "ollamaModel", "ollamaUrl"]);
  const ollama = cfg.provider === "ollama";
  log("message", { type: "window", from, to, cues: cues.length, provider: ollama ? "ollama" : "anthropic", apiKey: cfg.apiKey ? `set (${cfg.apiKey.length} chars)` : "not set" });
  return TopicSkipperLlm.analyzeWindow(cues, { from, to }, {
    provider: ollama ? "ollama" : "anthropic",
    apiKey: cfg.apiKey,
    model: (ollama ? cfg.ollamaModel : cfg.model) || undefined,
    ollamaUrl: cfg.ollamaUrl || undefined,
    log,
  });
}
