# 🧊 dsh-ice-probe

A tiny [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that appends a 🧊 marker to the end of **every sentence** the model writes — including its **chain of thought** — and plays a short sound for each insertion.

It is a mechanical output-pipeline transform, **not** a prompt. The model is never asked to add emoji, so it cannot forget, miscount, or imitate.

```
The plan … 
- first read the file … 
- then rewrite it. This keeps things simple.
```
becomes
```
The plan🧊🧊🧊 …
- first read the file🧊🧊🧊 …
- then rewrite it🧊🧊🧊. This keeps things simple🧊🧊🧊.
```
…and you hear a small blip each time a 🧊 lands on the screen.

---

## Features

- **Sentence-end ice for text *and* reasoning.** Implemented on the host `llm/stream` waterfall, so it works for every model call.
- **Survives settling.** The settled copy of a finished step is transformed too, so the ice does not disappear when reasoning collapses.
- **Sound for every insertion.** A short synthesized tone; no audio assets, no downloads. Queue length selects one of four tiers, and a tier drains that many ice markers from the queue.
- **Idempotent.** Text that already has ice in front of its punctuation is left alone.
- **Safe.** Code fences, inline code, numbers (`2.5`), filenames (`core.js`), abbreviations (`e.g.`), tool-call arguments, session titles, compaction summaries and sub-agent/workflow sessions are never touched.
- **No configuration required.** Enable it: it applies. Disable it: the module is unloaded.

## Install

```bash
dsh plugin add github:OWNER/dsh-ice-probe
```

(`OWNER` = the GitHub account that publishes this repository.)

Then make sure the plugin is **enabled** in the plugin marketplace. Enabling/disabling the plugin is the on/off switch — there is no in-conversation toggle.

### Manual install

If you prefer to install it by hand:

1. Clone or copy this repository anywhere.
2. Add a link dependency to your profile's `package.json`:
   ```json
   "@local/dsh-ice-probe": "link:D:/path/to/dsh-ice-probe"
   ```
3. Register the bundle in the same file:
   ```json
   "dsh": { "profile": { "bundles": ["@local/dsh-ice-probe"] } }
   ```
4. Make sure `node_modules/@local/dsh-ice-probe` resolves to the plugin directory.

## Verify it works

The host half serves two local routes under your DSH web server:

| Route | Purpose |
| --- | --- |
| `/ice-probe/` | Live counters, the last few rewrites (`samples`), skip counters, last error |
| `/ice-probe/selftest` | The built-in sentence-transform test suite (also `npm run selftest`) |

`/ice-probe/` returning 404 means the plugin is not mounted (disabled in the marketplace, or not installed).

## Behavior and limits

- **Ice goes before the punctuation**, so the sentence stays grammatical and copy/paste keeps normal punctuation at the end.
- **Chinese:** `。 ！ ？ …` always get ice.
- **English:** `! ?` always get ice (a run such as `!!!` counts once). A period only gets ice when it is followed by whitespace, a newline, or the end of the text — so decimals, versions, filenames and abbreviations are left alone.
- **Never iced:** fenced/inline code, tool-call arguments, session titles, compaction summaries, sub-agent and workflow output.
- **The ice is written into the conversation log.** It is part of the assistant message from then on; turning the plugin off does not remove ice from old messages, and the extra characters count toward the context.
- **Sound requires a user gesture** (browser autoplay policy). The first click/keypress on the page unlocks audio; until then ice is counted silently and plays once unlocked.

## Privacy

- Everything runs locally: a host transform and a client-side counter.
- No telemetry, no network calls, no data collection. The two routes above are served by your own DSH web server.
- The plugin only ever *adds* characters to model output; it never rewrites existing text away.

## License

[MIT](./LICENSE)
