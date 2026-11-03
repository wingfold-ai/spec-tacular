# Proposals: evidence that the implementation is correct

spec-tacular makes sure a human **accepted** what gets built. It does not yet
show that what got built **does** what was accepted: a ticked task is a claim,
not evidence. These six changes close that gap, step by step, borrowing from
two sources:

- **NASA FRET** — requirements written in structured English (FRETish) with a
  precise meaning over time, typed variables in a glossary, and tests derived
  from the formula rather than written by hand.
- **Proof (reqproof.com)** — every requirement in two forms (prose and a formal
  condition), hazards stated as "what must not happen", evidence that goes
  stale when its basis changes, and the rule that a regression test must fail
  before the fix and pass after it.

Each proposal is written to the spec-tacular schema's `proposal.md` template,
so it can be copied to `openspec/changes/<name>/proposal.md` and run through
the normal pipeline (specs → risks → design → tasks).

## Order

| # | Change | Depends on | Delivers on its own |
|---|---|---|---|
| 1 | [add-change-risks](add-change-risks.md) ✅ implemented | — | Every change states what could go wrong and what it may touch; each risk gets a guard test that is shown to fail without its mitigation |
| 2 | [add-consequence-classes](add-consequence-classes.md) ✅ implemented | 1 | Areas of code classed by what a failure costs; a change inherits the highest class it touches, and the class sets how much rigor every later stage demands; AI-written P0 code is reviewed as a diff |
| 3 | [add-verification-evidence](add-verification-evidence.md) ◐ core implemented | 1 | Tests name what they verify; results kept per item, appended, with missing / passing / failing / stale / excepted; Test, Analysis, Inspection or Demonstration per item; a verification matrix; guard proofs replayed; an evidence pack at archive |
| 4 | [add-hazard-register](add-hazard-register.md) ✅ implemented | 1, 3 | Risks outlive their change: a project register of hazards, their controls and verification, status driven by evidence, read by every later risks draft |
| 5 | [add-defect-changes](add-defect-changes.md) ✅ implemented | 1, 3 | A bug fix starts by deciding whether the code or the requirement was wrong, and carries a reproducer that fails before the fix |
| 6 | [add-formal-requirements](add-formal-requirements.md) ✅ implemented | — | An optional formal form per requirement over a typed glossary, the prose staying authoritative; formalizing sends its questions back into the prose |
| 7 | [add-test-matrix](add-test-matrix.md) ✅ implemented | 3, 6 | The full test matrix generated from each formal form, with impossible rows marked and dead conditions reported, run as table-driven tests, evidence per row; how much must pass follows the class |
| 8 | [add-harness-assurance](add-harness-assurance.md) ✅ implemented | 7 | Proof that the matrix tests the real code: pure decision functions, declarative mappings, isolation, red before implementation, coverage read as a question about the requirements, mutation checks, a review per variable |
| 9 | [add-fret-interop](add-fret-interop.md) ◐ implemented, waits for FRET to be installed once | 6, 7 | FRET for realizability and its own test generation, and as the qualification of spec-tacular's semantics; runtime monitors from the same formula, checked for monitorability |

Classifying comes second on purpose: the NASA practice book's playbook
classifies before adding any other rigor, and every change after it reads the
class instead of applying the most expensive check everywhere. 1–5 pay off
for a project that never writes a formula; 6 is independent of them; 9 is
optional.

### What the NASA practice book changed

Leonid Bugaev's *Applying NASA, Automotive & Safety-Critical Engineering to
Software* (<https://buger.github.io/nasa-presentation/book.html>) shows how
FRET, MC/DC and hazard analysis are used in practice. It confirmed the
direction — FRET-derived MC/DC tests in table-driven CI tests named by
requirement id is its own recommendation — and changed it in these places:

| Finding | Where it went |
|---|---|
| Rigor is proportional to consequence; classify first | new: add-consequence-classes |
| Hazards are tracked for the system's life, with controls, verification, status | new: add-hazard-register |
| Most defects are requirement defects; every fix decides which | new: add-defect-changes |
| Failure-mode guide words (STPA, software failure modes, STRIDE); hazard causes | applied to add-change-risks |
| "Accepted" means two things in a risk review | applied: `Unmitigated:` |
| An agent recording its own proof is self-certification | add-verification-evidence replays it |
| Four verification methods; RVTM; bidirectional traceability; immutable evidence; negative tests; evidence packs | add-verification-evidence |
| The prose stays authoritative; formalize ~half; "questions back"; negation; Decide → Plan → Execute | add-formal-requirements |
| Coupled conditions, infeasible rows, unique-cause vs masking pairs, dead conditions; N+1 vs 2ⁿ | add-test-matrix |
| Coverage as a diagnostic of requirements completeness; tool qualification with known-pass/known-fail cases | add-harness-assurance |
| CI tests, model-checking proofs and runtime monitors from one formula; monitorability | add-fret-interop |

Left out for now, though the book covers them: deployment and rollout safety,
incident investigation boards, supply-chain governance (SBOM, SLSA), metrics
programs, and interface control documents. They are about operating a system,
not about whether one change does what was accepted, which is what
spec-tacular checks. Interface contracts could come back as a spec type of
their own.

## How the pieces connect

```
requirement (prose + formal) ─┐
glossary (typed variables)  ──┼─► matrix (generated) ─► table-driven test ─► evidence per row
risk (hazard + guard)        ─┘                           ▲
                                     harness / mapping ───┘  (reviewed per variable,
                                                              shown to reach the real code)
```

A change is *verified* when:

1. its requirements and risks are accepted (today's review, extended to risks);
2. every formal requirement and every risk guard has a generated matrix;
3. the mapping from glossary variables to code is reviewed, and shown to be
   connected to the real implementation;
4. every row passes, or a person has excepted it with a reason;

and nothing of this has changed since. Any missing link is named by the
archive gate.

## What this does not claim

- Matrix coverage is coverage **of the formula**, not of the code. Proof says
  the same of its MC/DC cases. Code coverage (change 5) is a separate measure.
- The full matrix of a pure boolean decision is exhaustive for that function,
  and so amounts to a proof, but only if the function reads nothing beyond its
  listed inputs. That is a review question, not something a tool can see.
- FRET's own guarantees come from model checking a model (Kind 2 over Lustre
  via CoCoSim), not from tests over code. Change 6 uses FRET where it applies;
  changes 3–5 do not depend on it.

## Unverified, to settle in the specs or design

- ~~Whether `openspec validate` accepts an extra fenced block inside a
  requirement body.~~ Settled: it does (OpenSpec 1.13), and spec-tacular's
  parser keeps the block in the requirement's text, so it is hashed with it.
- FRET's exact finite-trace semantics for edge cases. Partly settled: FRET's
  documented ft-fin formula for `within N` — `((F[0,N] x) | (F[0,N-1] LAST))`
  — agrees with spec-tacular's reading on every trace tried, inclusive bounds
  and a window running past the end included. `upon` at the first timepoint,
  `until`/`before` without their stop, and scopes are not yet compared with
  FRET's own formulas: `spec-tacular fret check` does that wherever FRET is
  installed once.
- Proof's public pages do not describe how it turns a hazard into a test; the
  "guard must fail without its mitigation" rule in change 1 is our own.

## Sources

- FRET: <https://github.com/NASA-SW-VnV/fret>, its user manual
  (`fret-electron/docs/_media/`), in particular *Writing requirements* and the
  *Test case generation* manual (FLIP coverage, Kind 2 / NuSMV backends)
- FRETting about Requirements: <https://arxiv.org/pdf/2112.04251.pdf>
- Proof: <https://reqproof.com>, <https://reqproof.com/product>,
  <https://reqproof.com/llms.txt>
- Leonid Bugaev, *Applying NASA, Automotive & Safety-Critical Engineering to
  Software* (2026): <https://buger.github.io/nasa-presentation/book.html> —
  in particular §1.2 (verification methods, FRET in practice, MC/DC and
  coupled conditions), §1.6 (traceability, RVTM), §2.7 (signals catalog),
  §6.4 (tool qualification), §7.2 (hazard reports), §9 (classification and
  the adoption playbook)
