#!/usr/bin/env python3
"""Reproduce the cache-aware compaction feasibility estimate from pi session history.

Reads ~/.pi/agent/sessions/**/*.jsonl and estimates the net cost effect of
compacting at the start of every resumed burst (a burst is a run of assistant
turns separated by <= --burst-min idle gaps).

Mechanics verified in pi's source (dist/core/compaction/compaction.js):
  * summarization uses its own system prompt and cacheRetention:"none", so it
    NEVER hits the conversation prompt cache: it pays input price for the
    serialized conversation, regardless of when it runs;
  * serialization truncates tool results to 2000 chars, so its input can be
    smaller than the context it summarizes. --ser-frac parameterizes the ratio
    (1.0 = conservative, no truncation benefit).

Usage:
  python3 scripts/analyze-sessions.py
  python3 scripts/analyze-sessions.py --ser-frac 1.0 --floor 60000
"""

import argparse
import datetime as dt
import glob
import json
import os
from collections import defaultdict

ROOT = os.path.expanduser("~/.pi/agent/sessions")


def num(x):
    return x or 0


def parse_ts(value):
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def read_turns(path):
    """Assistant turns on the linear file path, resetting at compaction boundaries."""
    turns = []
    try:
        handle = open(path, errors="replace")
    except OSError:
        return turns
    with handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            kind = entry.get("type")
            if kind in ("compaction", "branch_summary"):
                # Context legitimately changed; prior turns are not "inherited" anymore.
                turns = []
                continue
            if kind != "message":
                continue
            message = entry.get("message", {})
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage")
            if not usage:
                continue
            ts = parse_ts(entry.get("timestamp")) or message.get("timestamp")
            if ts and ts > 1e12:
                ts /= 1000.0
            cost = usage.get("cost", {}) or {}
            turns.append({
                "ts": ts,
                "provider": message.get("provider"),
                "model": message.get("model"),
                "input": num(usage.get("input")),
                "cache_read": num(usage.get("cacheRead")),
                "cache_write": num(usage.get("cacheWrite")),
                "output": num(usage.get("output")),
                "cost": num(cost.get("total")),
                "cost_input": num(cost.get("input")),
                "cost_cache_read": num(cost.get("cacheRead")),
                "cost_cache_write": num(cost.get("cacheWrite")),
                "cost_output": num(cost.get("output")),
            })
    return turns


def burstify(turns, gap_seconds):
    bursts = []
    i = 0
    while i < len(turns):
        j = i
        while (
            j + 1 < len(turns)
            and turns[j + 1]["ts"]
            and turns[j]["ts"]
            and (turns[j + 1]["ts"] - turns[j]["ts"]) <= gap_seconds
        ):
            j += 1
        gap = (turns[i]["ts"] - turns[i - 1]["ts"]) if (i > 0 and turns[i]["ts"] and turns[i - 1]["ts"]) else None
        bursts.append({"turns": turns[i : j + 1], "gap": gap})
        i = j + 1
    return bursts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ttl-min", type=float, default=5.0, help="cache TTL / idle threshold in minutes")
    parser.add_argument("--burst-min", type=float, default=30.0, help="gap that ends a burst, in minutes")
    parser.add_argument("--floor", type=int, default=60000, help="minimum context tokens worth compacting")
    parser.add_argument("--small", type=int, default=22000, help="post-compaction context estimate (tokens)")
    parser.add_argument("--summary-out", type=int, default=3000, help="summary output tokens")
    parser.add_argument("--ser-frac", type=float, default=0.5, help="summarizer input as a fraction of context")
    args = parser.parse_args()

    ttl = args.ttl_min * 60
    burst_gap = args.burst_min * 60

    total_cost = 0.0
    actual_burst_cost = 0.0
    new_burst_cost = 0.0
    resumes = 0
    per_model = defaultdict(lambda: {"n": 0, "net": 0.0})

    for path in glob.glob(os.path.join(ROOT, "*", "*.jsonl")):
        turns = read_turns(path)
        if not turns:
            continue
        total_cost += sum(t["cost"] for t in turns)
        for burst in burstify(turns, burst_gap):
            if not (burst["gap"] and burst["gap"] > ttl):
                continue
            first = burst["turns"][0]
            context = first["input"] + first["cache_write"] + first["cache_read"]
            if context <= args.floor:
                continue
            paid_tokens = first["input"] + first["cache_write"]
            paid_rate = (first["cost_input"] + first["cost_cache_write"]) / paid_tokens if paid_tokens else 0.0
            input_rate = first["cost_input"] / first["input"] if first["input"] else paid_rate
            cache_read_rate = first["cost_cache_read"] / first["cache_read"] if first["cache_read"] else paid_rate * 0.1
            output_rate = first["cost_output"] / first["output"] if first["output"] else input_rate * 4
            inheritable = context - args.small

            # Each turn stops re-reading the inherited context, bounded by what is left
            # of the inherited tokens after the keep-window.
            savings = 0.0
            for index, turn in enumerate(burst["turns"]):
                prompt = turn["input"] + turn["cache_write"] + turn["cache_read"]
                rate = paid_rate if index == 0 else (
                    turn["cost_cache_read"] / turn["cache_read"] if turn["cache_read"] else cache_read_rate
                )
                removed = min(max(0.0, prompt - args.small), inheritable)
                savings += removed * rate
            summary_cost = args.ser_frac * context * input_rate + args.summary_out * output_rate
            net = savings - summary_cost

            actual = sum(t["cost"] for t in burst["turns"])
            actual_burst_cost += actual
            new_burst_cost += actual - net
            resumes += 1
            key = f'{first["provider"]}/{first["model"]}'
            per_model[key]["n"] += 1
            per_model[key]["net"] += net

    print(f"ttl={args.ttl_min}m burst={args.burst_min}m floor={args.floor} small={args.small} "
          f"summary_out={args.summary_out} ser_frac={args.ser_frac}")
    print(f"total recorded cost (all turns):        ${total_cost:,.2f}")
    print(f"actual cost of resumed bursts:          ${actual_burst_cost:,.2f}")
    print(f"modelled cost with reactive compaction: ${new_burst_cost:,.2f}")
    print(f"net effect:                             ${actual_burst_cost - new_burst_cost:+,.2f} "
          f"over {resumes} compactions")
    print()
    print(f"{'model':<46} {'resumes':>7} {'net':>10}")
    for key, value in sorted(per_model.items(), key=lambda kv: -kv[1]["net"]):
        print(f"{key:<46} {value['n']:>7} ${value['net']:>+9.3f}")


if __name__ == "__main__":
    main()
