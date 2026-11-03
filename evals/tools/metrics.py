#!/usr/bin/env python3
"""
Measures an evaluation run from what it left behind, the same way for every
version of spec-tacular, so runs are compared on numbers rather than on an
evaluator's impression.

    metrics.py <run-dir>            writes <run-dir>/metrics.json and metrics.md

What it reads, all optional, none of it written by the evaluator except
phases.tsv:

- `project/.spec-tacular/jobs/*.json|.log`: each drafting job — artifact,
  start, end, the cost Claude reported.
- Claude Code's transcripts of the project (~/.claude/projects/<path>/):
  tokens per session, the implementing session's above all, which reports
  no cost.
- `project/.spec-tacular/usage.jsonl`: the TUI's own sessions (advisor,
  interview, revisions), in versions that keep it.
- `project/.spec-tacular/review/*.json`: what was reviewed, by kind.
- `project/spec-tacular/foundation/*.md`, `vision-session.json`: the
  questions asked up front, answered or left for later.
- `phases.tsv` (the evaluator's): phase, start, end, decisions — per phase
  wall clock, and how much of it was waiting for the AI.
- `prompts.log`: permission prompts in the implementing session.
- The produced code: source and test lines, tests and their result.
"""

import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys

GENERATED = re.compile(
    r"^(openspec|spec-tacular|\.spec-tacular|node_modules|test/matrix)/|spec-tacular-matrix\.ts$|(^|/)bun\.lock$"
)
SOURCE = re.compile(r"\.(ts|tsx|js|mjs|cjs|py)$")
TEST = re.compile(r"(^|/)(test|tests|__tests__)/|\.(test|spec)\.[a-z]+$")


def ts(s):
    return dt.datetime.fromisoformat(s)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def jobs(project):
    out = []
    for meta_path in sorted(glob.glob(f"{project}/.spec-tacular/jobs/*.json")):
        meta = read_json(meta_path) or {}
        cost = None
        try:
            with open(meta_path[:-5] + ".log") as f:
                for line in f:
                    m = re.search(r'"total_cost_usd":([0-9.]+)', line)
                    if m:
                        cost = float(m.group(1))
        except OSError:
            pass
        start, end = meta.get("startedAt"), meta.get("endedAt")
        out.append(
            {
                "artifact": meta.get("artifact"),
                "start": start,
                "minutes": round((ts(end) - ts(start)).total_seconds() / 60, 2)
                if start and end
                else None,
                "cost_usd": cost,
                "status": meta.get("status"),
            }
        )
    return out


def transcripts(project):
    """Every Claude Code session run in the project, with its tokens."""
    d = os.path.expanduser(
        "~/.claude/projects/" + re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(project))
    )
    out = []
    for f in sorted(glob.glob(f"{d}/*.jsonl"), key=os.path.getmtime):
        seen, first, stamps = set(), None, []
        tok = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "turns": 0}
        entrypoint = None
        with open(f) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("timestamp"):
                    stamps.append(e["timestamp"])
                entrypoint = entrypoint or e.get("entrypoint")
                msg = e.get("message") or {}
                if (
                    e.get("type") == "user"
                    and first is None
                    and isinstance(msg.get("content"), str)
                ):
                    first = msg["content"]
                if (
                    e.get("type") == "assistant"
                    and msg.get("usage")
                    and msg.get("id") not in seen
                ):
                    seen.add(msg.get("id"))
                    u = msg["usage"]
                    tok["input"] += u.get("input_tokens", 0)
                    tok["cache_read"] += u.get("cache_read_input_tokens", 0)
                    tok["cache_write"] += u.get("cache_creation_input_tokens", 0)
                    tok["output"] += u.get("output_tokens", 0)
                    tok["turns"] += 1
        if not stamps:
            continue
        kind = "interactive" if entrypoint == "cli" else "headless"
        if first and "Work through pending tasks" in first:
            kind = "implementing"
        out.append(
            {
                "kind": kind,
                "start": stamps[0],
                "end": stamps[-1],
                "minutes": round(
                    (ts(stamps[-1]) - ts(stamps[0])).total_seconds() / 60, 2
                ),
                **tok,
            }
        )
    return out


def usage_log(project):
    out = {
        "requests": 0,
        "cost_usd": 0.0,
        "output": 0,
        "cache_write": 0,
        "cache_read": 0,
    }
    try:
        with open(f"{project}/.spec-tacular/usage.jsonl") as f:
            for line in f:
                u = json.loads(line)
                out["requests"] += 1
                out["cost_usd"] += u.get("costUsd") or 0
                out["output"] += u.get("outputTokens") or 0
                out["cache_write"] += u.get("cacheWriteTokens") or 0
                out["cache_read"] += u.get("cacheReadTokens") or 0
    except OSError:
        return None
    out["cost_usd"] = round(out["cost_usd"], 2)
    return out


def review(project):
    kinds = {}
    for path in glob.glob(f"{project}/.spec-tacular/review/*.json"):
        doc = read_json(path) or {}
        for key, entry in (doc.get("requirements") or {}).items():
            cap = key.split("#")[0]
            kind = (
                "risk"
                if cap == "risks"
                else "decision"
                if cap == "design"
                else "harness"
                if cap.startswith("harness/")
                else "question"
                if cap == "questions"
                else "requirement"
            )
            k = kinds.setdefault(
                kind, {"items": 0, "accepted": 0, "deferred": 0, "rejected": 0}
            )
            k["items"] += 1
            if entry.get("state") in k:
                k[entry["state"]] += 1
        kinds["documents accepted"] = len(doc.get("documents") or {})
    return kinds


def questions(project):
    """The questions asked before the first change: answered, or left for later."""
    answered = deferred = 0
    for path in glob.glob(f"{project}/spec-tacular/foundation/*.md"):
        with open(path) as f:
            sections = re.split(r"^## ", f.read(), flags=re.MULTILINE)[1:]
        for s in sections:
            if re.search(r"Decide later|^TBD\s*$", s, re.MULTILINE):
                deferred += 1
            else:
                answered += 1
    vision = read_json(f"{project}/.spec-tacular/vision-session.json") or {}
    turns = vision.get("turns") or []
    return {
        "interview_asked": len(turns),
        "interview_answered": sum(1 for t in turns if t.get("answer")),
        "ground_rules_answered": answered,
        "ground_rules_left_for_later": deferred,
        "roadmap_slices": len(vision.get("slices") or []),
    }


def phases(run):
    """phase<TAB>start HH:MM:SS<TAB>end HH:MM:SS<TAB>decisions, by the evaluator."""
    rows = []
    try:
        with open(f"{run}/phases.tsv") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 3 or parts[0].lower() == "phase":
                    continue
                rows.append(
                    {
                        "phase": parts[0],
                        "start": parts[1],
                        "end": parts[2],
                        "decisions": int(parts[3])
                        if len(parts) > 3 and parts[3].strip().isdigit()
                        else None,
                    }
                )
    except OSError:
        pass
    return rows


def wait_minutes(phase, sessions, jobs_, day, offset):
    """Minutes within a phase in which an agent was working: the developer waits, or works alongside."""

    def at(hms):
        h, m, s = (int(x) for x in (hms.split(":") + ["0"])[:3])
        return dt.datetime.combine(day, dt.time(h, m, s), tzinfo=offset)

    try:
        a, b = at(phase["start"]), at(phase["end"])
    except ValueError:
        return None
    spans = [(ts(s["start"]), ts(s["end"])) for s in sessions]
    spans += [
        (ts(j["start"]), ts(j["start"]) + dt.timedelta(minutes=j["minutes"]))
        for j in jobs_
        if j["start"] and j["minutes"]
    ]
    spans = sorted((max(x, a), min(y, b)) for x, y in spans if y > a and x < b)
    total, cur = 0.0, None
    for x, y in spans:
        if cur and x <= cur[1]:
            cur = (cur[0], max(cur[1], y))
        else:
            if cur:
                total += (cur[1] - cur[0]).total_seconds()
            cur = (x, y)
    if cur:
        total += (cur[1] - cur[0]).total_seconds()
    return round(total / 60, 1)


def code(project):
    try:
        files = subprocess.run(
            ["git", "ls-files", "-co", "--exclude-standard"],
            check=False,
            cwd=project,
            capture_output=True,
            text=True,
        ).stdout.split("\n")
    except OSError:
        files = []
    src = tst = 0
    for f in files:
        if not f or GENERATED.search(f) or not SOURCE.search(f):
            continue
        try:
            with open(os.path.join(project, f)) as fh:
                n = sum(1 for line in fh if line.strip())
        except OSError:
            continue
        if TEST.search(f):
            tst += n
        else:
            src += n
    result = {"source_lines": src, "test_lines": tst}
    if os.path.exists(os.path.join(project, "package.json")):
        r = subprocess.run(
            ["bun", "test"],
            check=False,
            cwd=project,
            capture_output=True,
            text=True,
            timeout=600,
        )
        out = r.stdout + r.stderr
        for key in ("pass", "fail", "skip"):
            m = re.search(rf"^\s*(\d+) {key}$", out, re.MULTILINE)
            result[f"tests_{key}"] = int(m.group(1)) if m else 0
    return result


def main():
    run = os.path.abspath(sys.argv[1])
    project = f"{run}/project"
    j = jobs(project)
    sessions = transcripts(project)
    impl = [s for s in sessions if s["kind"] == "implementing"]
    tui = usage_log(project)
    prompts = 0
    try:
        with open(f"{run}/prompts.log") as f:
            prompts = sum(1 for line in f if line.startswith("=== prompt"))
    except OSError:
        pass
    ph = phases(run)
    if ph and (j or sessions):
        first = ts((j or sessions)[0]["start"]).astimezone()
        for p in ph:
            p["minutes"] = None
            try:
                h1, m1 = (int(x) for x in p["start"].split(":")[:2])
                h2, m2 = (int(x) for x in p["end"].split(":")[:2])
                p["minutes"] = (h2 * 60 + m2) - (h1 * 60 + m1)
            except ValueError:
                pass
            p["agent_minutes"] = wait_minutes(
                p, sessions, j, first.date(), first.tzinfo
            )

    drafting_cost = round(sum(x["cost_usd"] or 0 for x in j), 2)
    m = {
        "label": os.path.basename(run),
        "jobs": j,
        "drafting": {
            "jobs": len(j),
            "by_artifact": {
                a: sum(1 for x in j if x["artifact"] == a)
                for a in sorted({x["artifact"] for x in j if x["artifact"]})
            },
            "minutes": round(sum(x["minutes"] or 0 for x in j), 1),
            "cost_usd": drafting_cost,
        },
        "tui_sessions": tui,
        "implementing": {
            "sessions": len(impl),
            "minutes": round(sum(s["minutes"] for s in impl), 1),
            "output_tokens": sum(s["output"] for s in impl),
            "cache_read_tokens": sum(s["cache_read"] for s in impl),
            "cache_write_tokens": sum(s["cache_write"] for s in impl),
            "permission_prompts": prompts,
        },
        "reported_cost_usd": round(drafting_cost + (tui["cost_usd"] if tui else 0), 2),
        "questions": questions(project),
        "review": review(project),
        "phases": ph,
        "code": code(project),
    }
    with open(f"{run}/metrics.json", "w") as f:
        json.dump(m, f, indent=2)
    with open(f"{run}/metrics.md", "w") as f:
        f.write(render(m))
    print(render(m))


def render(m):
    d, i, q, c = m["drafting"], m["implementing"], m["questions"], m["code"]
    lines = [f"# Metrics: {m['label']}", ""]
    if m["phases"]:
        lines += [
            "| Phase | Wall min | Agent working min | Decisions |",
            "|---|---|---|---|",
        ]
        for p in m["phases"]:
            lines.append(
                f"| {p['phase']} | {p.get('minutes')} | {p.get('agent_minutes')} | {p.get('decisions') if p.get('decisions') is not None else ''} |"
            )
        lines.append("")
    lines += [
        "| Measure | Value |",
        "|---|---|",
        f"| Drafting jobs | {d['jobs']} ({', '.join(f'{k} ×{v}' for k, v in d['by_artifact'].items())}) |",
        f"| Drafting agent minutes | {d['minutes']} |",
        f"| Cost reported (drafting + TUI sessions) | ${m['reported_cost_usd']} |",
        f"| Implementing minutes / output tokens / cache reads | {i['minutes']} / {i['output_tokens']:,} / {i['cache_read_tokens']:,} |",
        f"| Permission prompts while implementing | {i['permission_prompts']} |",
        f"| Interview questions asked / answered | {q['interview_asked']} / {q['interview_answered']} |",
        f"| Ground rules answered / left for later | {q['ground_rules_answered']} / {q['ground_rules_left_for_later']} |",
        f"| Roadmap slices proposed | {q['roadmap_slices']} |",
    ]
    for kind, r in m["review"].items():
        if isinstance(r, dict):
            lines.append(
                f"| Reviewed: {kind}s | {r['items']} ({r['accepted']} accepted, {r['deferred']} deferred, {r['rejected']} rejected) |"
            )
    lines += [
        f"| Source lines / test lines | {c.get('source_lines')} / {c.get('test_lines')} |",
        f"| Tests pass / fail | {c.get('tests_pass', '?')} / {c.get('tests_fail', '?')} |",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    main()
