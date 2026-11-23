importScripts("llm.js");

// Content scripts ask us to split a video; we call the API here so the key never touches the page.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "segment") return;
  run(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true; // async response
});

async function run({ videoId, cues, duration }) {
  const cacheKey = `seg:${videoId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return { segments: cached, cached: true };

  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  const { segments, usage } = await TopicSkipperLlm.analyze(cues, duration, { apiKey, model: model || undefined });
  if (segments.length) await chrome.storage.local.set({ [cacheKey]: segments });
  return { segments, usage };
}
