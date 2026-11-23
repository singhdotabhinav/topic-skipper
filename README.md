# Topic Skipper

Chrome extension that skips to the next *topic or joke* on YouTube instead of a fixed 10 seconds.

## How it works
1. Fetches the video's transcript (YouTube's caption URL, falling back to the transcript panel).
2. **AI split (stand-up):** sends the transcript to Claude Haiku 5.5 (`claude-haiku-5-5`, the cheapest current model) which marks where each new bit starts: a single joke, a whole story (however long), or one crowd-work exchange with one person. Needs an API key: extension options page. Results are cached per video; an hour-long special costs well under a cent.
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
- AI path is tested against a stubbed API only; tune the prompt in `src/llm.js` on real specials.
- Next: other sites, per-site transcript adapters, other genres (prompt per theme).
