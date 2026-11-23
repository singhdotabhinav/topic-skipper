importScripts("llm.js");

// Content scripts ask us to analyse one window of a transcript; the API call happens here so the key
// never touches the page.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "window") return;
  run(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true; // async response
});

async function run({ cues, from, to }) {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  return TopicSkipperLlm.analyzeWindow(cues, { from, to }, { apiKey, model: model || undefined });
}
