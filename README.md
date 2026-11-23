# Topic Skipper

Chrome extension that skips to the next *topic or joke* on YouTube instead of a fixed 10 seconds.

## How it works
1. Fetches the video's transcript (YouTube's caption URL, falling back to the transcript panel).
2. **AI split (stand-up), lazily:** only 5 minutes of transcript go to Claude Haiku 5.5 (`claude-haiku-5-5`, cheapest current model) at a time. It marks where each new bit starts: a single joke, a whole story (however long), or one crowd-work exchange with one person. When the player gets within 2 minutes of the analysed edge, the next 5 minutes are fetched. A bit still running at the edge is re-analysed from its start with the next window, so a long story is judged as a whole; pressing `]` inside one keeps loading until its end is found. Seeking past the analysed range starts a fresh window there. Needs an API key (extension options). Results are cached per video.
3. **Basic split (no key / AI failed):** falls back to a local algorithm using two signals:
   - **Topic shifts**: vocabulary similarity before/after each point (TextTiling).
   - **Laughter**: `[Laughter]` / `[Applause]` caption markers; a boundary goes right after each burst, so "next part" = next joke.
4. Adds ⏮ ⏭ buttons (top-left of the player on hover), ticks on the progress bar, and a list of parts.

Keys: `]` next part, `[` previous part. The slider in the ☰ panel changes how finely it splits.

## Install (dev)
`chrome://extensions` → Developer mode → Load unpacked → pick this folder → open any YouTube video with captions.

## Free local testing with Ollama
Pick **Ollama** as the provider in the extension options (no API key, no tokens spent).
1. Install [Ollama](https://ollama.com/download) and pull a model: `ollama pull llama3.1:8b` (~5 GB; fits a 16 GB Mac).
2. Let the extension talk to it, then restart Ollama: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` (menu-bar app) or run `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`.
3. Reload the extension and open a stand-up video.
`llama3.1:8b` handled two independent synthetic sets well (whole stories, one bit per crowd-work person) after prompt tuning, at ~4-12 s per 5-minute window. It is still weaker than Claude Haiku 5.5 on messy real captions, so confirm quality on real specials with the Anthropic provider. Splits are cached per provider.

## Logs
Everything is logged with a `[topic-skipper HH:MM:SS.mmm] scope:event` prefix. Three places to read it:
- **In the player:** hover the video → ☰ → **Logs** (scrollable, with a *Copy all* button). It includes the background worker's lines too.
- **YouTube tab console:** DevTools (⌥⌘J) → Console, filter `topic-skipper`. Content-script lines plus the worker's lines (`bg:`), mirrored back with each response.
- **Service worker console:** `chrome://extensions` → Topic Skipper → *service worker* link.

Scopes: `transcript:` (which fetch path ran, track list, status, cue counts), `content:` (init, config, cache hit/miss, `window:request`/`response`, `state:merged`, `prefetch:trigger`, `seek`, `nav:next`/`prev`, `track:segment` on each bit change, `track:position` every 10 s with seconds to the analysed edge), `bg:` (the full request to Ollama/Anthropic: URL, model, options, prompt text; then status, latency, token counts, the raw model JSON, and raw vs kept bits after cleanup). API keys are never logged, only "set (N chars)".

## Test
`node test/segment.test.js && node test/llm.test.js`

## Known limits / next steps
- Auto-captions rarely contain `[Laughter]`, so stand-up relies on topic shifts there.
- Not yet tested against live YouTube across layouts; YouTube may block the timedtext call (then the transcript-panel fallback is used).
- AI path and windowing are tested against a stubbed API only (content script not yet exercised in a real browser); tune the prompt in `src/llm.js` on real specials.
- Next: other sites, per-site transcript adapters, other genres (prompt per theme).
