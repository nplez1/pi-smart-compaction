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
expire, so when you come back and send a small follow-up — fix a PR comment,
answer a review — the first request re-reads the entire context at the full
input price, and every later turn of that burst keeps carrying the same
inherited context.

Compacting before that first turn replaces the inherited context with a summary,
so the whole resumed burst runs on a much smaller prompt. On this machine's
history (619 sessions over ~5 months) that is worth roughly **$11–19**, best
estimate **~$16** — about **17% of the paid-provider spend** in the window.

That win depends on the cache being *actually cold*. It is not, on every
provider: see [Long-lived caches](#long-lived-caches-deepseek-waits-a-day).

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
| Time since the last request | `≥` cache lifetime | see [idle threshold](#the-idle-threshold) |

Compaction itself is pi's own default path — the extension does not override the
summarizer, keep-window, or summary format.

A transcript notice is written when it runs:

```
[smart-compaction] idle 4.2h · 312k→20k tokens
```

and the footer shows `smart-compact armed · ≥60k · idle≥5m`, then the result of
the last compaction.

### The idle threshold

Resolved from the most authoritative source first:

1. `idleThresholdMs` from the config file (global override);
2. a matching `idleThresholdByModel` entry;
3. the model's declared `promptCache.short` (what Anthropic models carry);
4. a **built-in model policy** — GitHub Copilot's `gpt-*` models: **30 minutes**;
5. a **built-in provider policy** — DeepSeek: **24 hours**; direct OpenAI: **30 minutes**;
6. the 5-minute fallback that matches pi's own cache-stats assumption.

## Long-lived caches: DeepSeek waits a day

DeepSeek enables [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache/)
for every request and clears an unused prefix only after "a few hours to a few
days". Its cache-hit rate is roughly **1/50** of the miss rate (`cacheRead`
0.006 vs `input` 0.3 per 1M tokens on `deepseek-flash`) and **cache writes are
free**.

So on DeepSeek a resume ten minutes — or ten hours — later is an ordinary cheap
cache read, not a cold start. The old 5-minute fallback had it exactly backwards:
it paid a full-price summary *and* threw away the cached prefix, because the
summary begins a new prefix. The provider policy is therefore 24h: conservative
within DeepSeek's "hours to days" window, and still compacting a session you
actually left overnight plus a day.

OpenAI prompt caches last 30 minutes, so OpenAI resumes are treated as warm until
that threshold passes. This includes `gpt-*` models served through the
`github-copilot` provider; other Copilot model families are not classified as
OpenAI. Use `idleThresholdByModel` to tune it for one model
(`{"deepseek/deepseek-v4-pro": 43200000}` for 12h) or to teach the extension about
another provider.

## Configuration

Optional file at `~/.config/pi-smart-compaction/config.json`:

```json
{
  "enabled": true,
  "contextFloorTokens": 60000,
  "idleThresholdMs": null,
  "idleThresholdByModel": {
    "deepseek/deepseek-v4-pro": 43200000
  },
  "notify": true,
  "status": true
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `contextFloorTokens` | `60000` | Minimum projected context worth compacting. |
| `idleThresholdMs` | `null` | Global idle threshold in ms. `null` uses the model/provider lifetime below. |
| `idleThresholdByModel` | `null` | Per-model idle thresholds in ms. Keys match `provider/modelId`, a bare model id, or a provider id; `*` is a wildcard (`deepseek/*`, `*`). The most specific match wins. |
| `notify` | `true` | Write the durable transcript notice and toast. |
| `status` | `true` | Show the footer status line. |

The file is read fresh on each decision, so edits apply without `/reload`.

## Command

`/smart-compaction` prints the current status (including which model and which
threshold source the gate is using); `/smart-compaction force` compacts
immediately regardless of the gate.

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
- The built-in policies cover DeepSeek at 24h (a conservative estimate for its
  documented "few hours to a few days"), direct OpenAI at 30m, and `gpt-*`
  models served by GitHub Copilot at 30m. A model that declares its own
  `promptCache` lifetime overrides them, and `idleThresholdByModel` tunes them.
- Only the session's own model cache lifetime is used for the idle threshold; a
  model that declares no `promptCache` on an unfamiliar provider falls back to
  pi's 5-minute assumption.
- Compaction is triggered through `ctx.compact()`, so it uses pi's global
  compaction settings (`keepRecentTokens`, `reserveTokens`) unchanged.
