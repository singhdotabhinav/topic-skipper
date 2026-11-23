importScripts("llm.js");

// Content scripts ask us to analyse one window of a transcript; the model call happens here so the
// API key never touches the page.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "window") return;
  run(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true; // async response
});

async function run({ cues, from, to }) {
  const cfg = await chrome.storage.local.get(["provider", "apiKey", "model", "ollamaModel", "ollamaUrl"]);
  const ollama = cfg.provider === "ollama";
  return TopicSkipperLlm.analyzeWindow(cues, { from, to }, {
    provider: ollama ? "ollama" : "anthropic",
    apiKey: cfg.apiKey,
    model: (ollama ? cfg.ollamaModel : cfg.model) || undefined,
    ollamaUrl: cfg.ollamaUrl || undefined,
  });
}
