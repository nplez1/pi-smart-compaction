# Feasibility analysis — cache-aware resume compaction

Estimate of how much a resume-time compactor would have saved, measured against
the session history on this machine (`~/.pi/agent/sessions`, 619 files,
2026-05 → 2026-10). All dollar figures are Pi's own local model-rate estimates,
not provider invoices.

Reproduce with:

```sh
python3 scripts/analyze-sessions.py            # --ser-frac 0.5
python3 scripts/analyze-sessions.py --ser-frac 1.0
```

## Method

1. Read every `.jsonl` session, keep assistant turns with `usage`, and reset at
   `compaction` / `branch_summary` boundaries (context legitimately changed).
2. Partition turns into **bursts**: runs of turns separated by ≤ 30 min gaps.
3. A **resume** is the first turn of a burst whose preceding gap exceeds the
   cache TTL (5 min) and whose inherited context exceeds the floor (60k tokens).
4. Per resume, derive the model's effective rates from that turn's own cost
   breakdown (`input`, `cacheRead`, `cacheWrite`, `output`).
5. Model the effect of compacting at the resume:
   - cost: `ser_frac × context × input_rate + summary_output × output_rate`;
   - benefit: every turn of the burst stops re-reading the inherited
     `context − keep_window` tokens, at the rate that turn actually paid.

`ser_frac` exists because `serializeConversation()` truncates tool results to
2000 characters, so the summarizer's input is smaller than the context it
compacts. `1.0` is the conservative bound (no truncation benefit).

## Results

| Quantity | Value |
| --- | --- |
| Total recorded cost, all turns | $197.78 |
| Actual cost of resumed bursts | $25.86 |
| Net effect, `ser_frac = 0.5` (best estimate) | **+$15.67** over 136 compactions |
| Net effect, `ser_frac = 1.0` (conservative) | **+$11.00** |
| Net effect, `ser_frac = 0.25` (optimistic) | +$18.04 |

Paid-provider spend (deepseek + xiaomi + fireworks) in the window is ~$90.76, so
the best estimate is roughly **17% of paid spend**; the remainder of the $198 is
GitHub Copilot, which bills by subscription rather than per token.

Savings are concentrated:

| Model | Resumes | Net (ser_frac 0.5) |
| --- | ---: | ---: |
| deepseek/deepseek-flash | 87 | +$7.77 |
| github-copilot/gpt-6-luna | 12 | +$5.03 |
| github-copilot/gpt-6.1-sol | 1 | +$1.10 |
| deepseek/deepseek-v4-flash | 18 | +$0.95 |
| xiaomi/mimo-v2.6-pro | 16 | +$0.53 |
| deepseek/deepseek-v4-pro | 2 | +$0.29 |

## Why the first read is not the saving

Pi's summarization request uses a dedicated `SUMMARIZATION_SYSTEM_PROMPT` and
`cacheRetention: "none"` (`dist/core/compaction/compaction.js`). It therefore
cannot reuse the conversation's prompt cache, and pays full input price for the
serialized conversation no matter when it runs. Consequences:

- **Reactive and proactive compaction cost the same** on the first read.
  Proactive additionally wastes a summary on sessions that are never resumed, so
  reactive dominates — which is why this extension triggers on input, not on idle.
- The saving is the **rest of the burst**: after compaction, later turns carry a
  small context instead of the inherited one. On these models cache reads are
  20–57× cheaper than input, so the effect is modest per turn but compounds over
  long bursts (median ~40 turns per resumed burst).

Resumes followed by 0–1 turns are individually net-negative (a few tenths of a
cent); the fixed `contextFloorTokens` gate keeps those small.

## Where the money actually goes (context for the design)

Across the same history:

- ~24% of spend ($46.99) is full-price prompt reads ("cold"), including session
  starts and post-compaction turns — not only idle resumes.
- ~12.4B cache-read tokens dominate volume; for deepseek alone, cache reads are
  $42.6 of $80.7 provider spend. The lever is **shrinking context**, and it
  applies to every turn, not just resumes.
- Idle resumes are a small slice of the cold-read total. The extension is a
  targeted, low-risk optimization, not a large cost driver.
