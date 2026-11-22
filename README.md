# Topic Skipper

Chrome extension that skips to the next *topic or joke* on YouTube instead of a fixed 10 seconds.

## How it works
1. Fetches the video's captions (falls back to YouTube's transcript panel).
2. Splits them into parts using two signals:
   - **Topic shifts**: vocabulary similarity before/after each point (TextTiling).
   - **Laughter**: `[Laughter]` / `[Applause]` caption markers; a boundary goes right after each burst, so "next part" = next joke.
3. Adds ⏮ ⏭ buttons (top-left of the player on hover), ticks on the progress bar, and a list of parts.

Keys: `]` next part, `[` previous part. The slider in the ☰ panel changes how finely it splits.

## Install (dev)
`chrome://extensions` → Developer mode → Load unpacked → pick this folder → open any YouTube video with captions.

## Test
`node test/segment.test.js`

## Known limits / next steps
- Auto-captions rarely contain `[Laughter]`, so stand-up relies on topic shifts there.
- Not yet tested against live YouTube across layouts; YouTube may block the timedtext call (then the transcript-panel fallback is used).
- Next: LLM-based segmentation with titles (optional API key), other sites, per-site transcript adapters.
