#!/usr/bin/env python3
"""
Prints kept evaluation runs side by side, from their metrics.json:

    compare.py evals/results/2026-10-30-main/ evals/results/2026-10-30-fret/

One column per run, one row per measure, with the change from the first run
in the last column. Numbers only: the reports say what they mean.
"""

import json
import os
import sys


def get(m, path):
    for key in path.split("."):
        if not isinstance(m, dict):
            return None
        m = m.get(key)
    return m


def items(m, kind):
    r = (m.get("review") or {}).get(kind)
    return r["items"] if isinstance(r, dict) else 0


ROWS = [
    ("Drafting jobs", lambda m: get(m, "drafting.jobs")),
    ("Drafting agent minutes", lambda m: get(m, "drafting.minutes")),
    ("Cost reported, USD", lambda m: get(m, "reported_cost_usd")),
    ("Implementing minutes", lambda m: get(m, "implementing.minutes")),
    ("Implementing output tokens", lambda m: get(m, "implementing.output_tokens")),
    ("Implementing cache reads", lambda m: get(m, "implementing.cache_read_tokens")),
    ("Permission prompts", lambda m: get(m, "implementing.permission_prompts")),
    ("Interview questions", lambda m: get(m, "questions.interview_asked")),
    ("Ground rules answered", lambda m: get(m, "questions.ground_rules_answered")),
    (
        "Ground rules left for later",
        lambda m: get(m, "questions.ground_rules_left_for_later"),
    ),
    ("Requirements reviewed", lambda m: items(m, "requirement")),
    ("Risks reviewed", lambda m: items(m, "risk")),
    ("Decisions reviewed", lambda m: items(m, "decision")),
    ("Harness bindings reviewed", lambda m: items(m, "harness")),
    (
        "Wall minutes (phases)",
        lambda m: sum(p.get("minutes") or 0 for p in m.get("phases") or []) or None,
    ),
    (
        "Agent-working minutes (phases)",
        lambda m: (
            round(sum(p.get("agent_minutes") or 0 for p in m.get("phases") or []), 1)
            or None
        ),
    ),
    (
        "Decisions by the developer",
        lambda m: sum(p.get("decisions") or 0 for p in m.get("phases") or []) or None,
    ),
    ("Source lines", lambda m: get(m, "code.source_lines")),
    ("Test lines", lambda m: get(m, "code.test_lines")),
    ("Tests passing", lambda m: get(m, "code.tests_pass")),
    ("Tests failing", lambda m: get(m, "code.tests_fail")),
]


def main():
    runs = []
    for d in sys.argv[1:]:
        with open(os.path.join(d, "metrics.json")) as f:
            runs.append((os.path.basename(os.path.normpath(d)), json.load(f)))
    if not runs:
        sys.exit("usage: compare.py <kept-run-dir>...")
    print("| Measure | " + " | ".join(n for n, _ in runs) + " | Change |")
    print("|---" * (len(runs) + 2) + "|")
    for name, fn in ROWS:
        vals = [fn(m) for _, m in runs]
        a, b = vals[0], vals[-1]
        change = ""
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a:
            change = f"{(b - a) / a:+.0%}"
        cells = [
            "–" if v is None else f"{v:,}" if isinstance(v, int) else str(v)
            for v in vals
        ]
        print(f"| {name} | " + " | ".join(cells) + f" | {change} |")


if __name__ == "__main__":
    main()
