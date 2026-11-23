const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; setTimeout(() => ($("msg").textContent = ""), 2000); };

chrome.storage.local.get(["apiKey", "model"]).then(({ apiKey, model }) => {
  $("key").value = apiKey || "";
  $("model").value = model || "";
});

$("save").onclick = async () => {
  await chrome.storage.local.set({ apiKey: $("key").value.trim(), model: $("model").value.trim() });
  say("Saved");
};

$("clear").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("seg:")));
  say("Cleared");
};
