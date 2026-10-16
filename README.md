# pi-smart-compaction

A [Pi](https://pi.dev) extension that compacts a long session **at the moment you
resume it**, instead of letting the first turn of the resumed burst re-read the
whole context at full price.

It is deliberately *reactive*: it never compacts while you are actively working,
and it never compacts a session just because it went idle. It waits until new
input arrives, checks that the prompt cache has expired, and only then pays for a
summary — so a session you never return to never pays for one.

## The problem

Sessions kept open for hours or days accumulate a large context. Prompt caches
expire (typically 5 minutes), so when you come back and send a small follow-up —
fix a PR comment, answer a review — the first request re-reads the entire
context at the full input price, and every later turn of that burst keeps
carrying the same inherited context.

Compacting before that first turn replaces the inherited context with a summary,
so the whole resumed burst runs on a much smaller prompt. On this machine's
history (619 sessions over ~5 months) that is worth roughly **$11–19**, best
estimate **~$16** — about **17% of the paid-provider spend** in the window.

## Why reactive-only (and not "compact while the cache is warm")

Pi's summarization request uses its own `SUMMARIZATION_SYSTEM_PROMPT` and sets
`cacheRetention: "none"` (`dist/core/compaction/compaction.js`). It therefore
**cannot hit the conversation's prompt cache**. A compaction always pays one
full-price read of the context, whenever it runs.

That has two consequences:

1. **Proactive compaction buys nothing.** Compacting at idle onset costs the same
   full-price read as compacting at resume — but it wastes a summary on every
   session you never return to. Reactive is strictly better.
2. **The win is the burst, not the first read.** The savings come from the turns
   *after* the resume no longer re-reading the inherited context. Resumes
   followed by a single turn are slightly net-negative; the value lives in the
   long bursts, which are the common case (median ~40 turns per resumed burst in
   the historical data).

See [`docs/analysis.md`](docs/analysis.md) for the full method and numbers, and
[`scripts/analyze-sessions.py`](scripts/analyze-sessions.py) to reproduce them
against your own `~/.pi/agent/sessions`.

## Behaviour

On every user input, while the session is idle, the extension compacts first if
**all** of these hold:

| Condition | Default | Source |
| --- | --- | --- |
| Extension enabled | `true` | config |
| Input is a real user prompt while idle | — | not streaming, not extension-injected |
| Projected context | `≥ 60,000` tokens | `contextFloorTokens` |
| Time since the last request | `≥` prompt-cache lifetime | model `promptCache.short`, else 5 min |

Compaction itself is pi's own default path — the extension does not override the
summarizer, keep-window, or summary format.

A transcript notice is written when it runs:

```
[smart-compaction] idle 4.2h · 312k→20k tokens
```

and the footer shows `smart-compact armed · ≥60k · idle≥5m`, then the result of
the last compaction.

## Configuration

Optional file at `~/.config/pi-smart-compaction/config.json`:

```json
{
  "enabled": true,
  "contextFloorTokens": 60000,
  "idleThresholdMs": null,
  "notify": true,
  "status": true
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `contextFloorTokens` | `60000` | Minimum projected context worth compacting. |
| `idleThresholdMs` | `null` | Idle threshold in ms. `null` uses the model's declared prompt-cache lifetime (falling back to 5 minutes). |
| `notify` | `true` | Write the durable transcript notice and toast. |
| `status` | `true` | Show the footer status line. |

The file is read fresh on each decision, so edits apply without `/reload`.

## Command

`/smart-compaction` prints the current status; `/smart-compaction force`
compacts immediately regardless of the gate.

## Install

Part of [pi-config](https://github.com/nplez1/pi-config) as the
`plugins/pi-smart-compaction` submodule. To use it standalone:

```sh
pi install /path/to/pi-smart-compaction
```

## Tests

```sh
npm test
```

The pure gate (`decision.ts`) and the registered-handler wiring
(`test/extension.test.mjs`) are both covered; no model calls are made.

## Limitations

- The gate cannot know how many turns a resumed burst will contain. It uses a
  fixed context floor rather than predicting burst length, which is why very
  short resumes lose the summary cost (a few tenths of a cent).
- Only the session's own model cache lifetime is used for the idle threshold; a
  model that declares no `promptCache` falls back to pi's 5-minute assumption.
- Compaction is triggered through `ctx.compact()`, so it uses pi's global
  compaction settings (`keepRecentTokens`, `reserveTokens`) unchanged.
