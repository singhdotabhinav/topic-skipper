const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; setTimeout(() => ($("msg").textContent = ""), 2000); };
const FIELDS = ["provider", "apiKey", "model", "ollamaUrl", "ollamaModel"];
const input = { provider: "provider", apiKey: "key", model: "model", ollamaUrl: "ollamaUrl", ollamaModel: "ollamaModel" };

function showGroup() {
  const ollama = $("provider").value === "ollama";
  $("ollama").hidden = !ollama;
  $("anthropic").hidden = ollama;
}

chrome.storage.local.get(FIELDS).then((cfg) => {
  for (const f of FIELDS) $(input[f]).value = cfg[f] || (f === "provider" ? "anthropic" : "");
  showGroup();
});
$("provider").onchange = showGroup;

$("save").onclick = async () => {
  const cfg = {};
  for (const f of FIELDS) cfg[f] = $(input[f]).value.trim();
  await chrome.storage.local.set(cfg);
  say("Saved");
};

$("clear").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("seg2:")));
  say("Cleared");
};
