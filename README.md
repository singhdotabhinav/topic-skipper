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

## Test
`node test/segment.test.js && node test/llm.test.js`

## Known limits / next steps
- Auto-captions rarely contain `[Laughter]`, so stand-up relies on topic shifts there.
- Not yet tested against live YouTube across layouts; YouTube may block the timedtext call (then the transcript-panel fallback is used).
- AI path and windowing are tested against a stubbed API only (content script not yet exercised in a real browser); tune the prompt in `src/llm.js` on real specials.
- Next: other sites, per-site transcript adapters, other genres (prompt per theme).
