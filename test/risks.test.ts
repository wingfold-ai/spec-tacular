import { describe, expect, test } from 'bun:test';
import {
  guardTasks,
  isRisk,
  missingFields,
  parseRisks,
  unansweredRisks,
  unguardedRisks,
  unprovenGuards,
} from '../src/core/risks.ts';
import { taskProgress } from '../src/core/tasks.ts';
import { hashDocument } from '../src/core/signoff.ts';
import { renderRequirement } from '../src/render/requirement.ts';

const RISKS = `# Risks

### Risk: Edited requirement stays accepted
- **Hazard:** a requirement edited after acceptance still counts as accepted
- **Affects:** review#drift-detection
- **Boundary:** edits made outside the TUI
- **Causes:** an editor or an agent writes the file directly
- **Severity:** high
- **Guard:** an edited requirement is never counted as accepted
- **Check:** a test edits an accepted requirement and expects it pending,
  whatever the editor was

### Risk: Archive loses deferred work
- **Hazard:** a deferred requirement disappears at archive
- **Severity:** medium
- **Unmitigated:** the register is out of this change's reach

\`\`\`
### Risk: Not a risk, inside a code block
\`\`\`

## Notes

Not part of any risk.
`;

describe('parseRisks', () => {
  const risks = parseRisks(RISKS, '/c/risks.md');

  test('reads every risk block, and none inside a code block', () => {
    expect(risks.map((r) => r.name)).toEqual(['Edited requirement stays accepted', 'Archive loses deferred work']);
    expect(risks.every(isRisk)).toBe(true);
  });

  test('gives each risk a stable id and the line of its header', () => {
    expect(risks[0]!.id).toBe('risks#edited-requirement-stays-accepted');
    expect(risks[0]!.line).toBe(3);
  });

  test('reads its fields, a wrapped one included', () => {
    expect(risks[0]!.severity).toBe('high');
    expect(risks[0]!.causes).toBe('an editor or an agent writes the file directly');
    expect(risks[0]!.check).toBe('a test edits an accepted requirement and expects it pending, whatever the editor was');
    expect(risks[1]!.unmitigated).toBe("the register is out of this change's reach");
  });

  test('ends a risk at the next section', () => {
    expect(risks[1]!.text).not.toContain('Not part of any risk');
  });

  test('an edit to its words changes its hash, reflowing does not', () => {
    const edited = parseRisks(RISKS.replace('Severity:** high', 'Severity:** low'), 'f')[0]!;
    const reflowed = parseRisks(RISKS.replace('pending,\n  whatever', 'pending,   whatever'), 'f')[0]!;
    expect(edited.hash).not.toBe(risks[0]!.hash);
    expect(reflowed.hash).toBe(parseRisks(RISKS.replace('pending,\n  whatever', 'pending, whatever'), 'f')[0]!.hash);
  });

  test('two risks of the same name get distinct ids', () => {
    const twice = parseRisks('### Risk: Same\n- **Hazard:** a\n\n### Risk: Same\n- **Hazard:** b\n', 'f');
    expect(twice.map((r) => r.id)).toEqual(['risks#same', 'risks#same~2']);
  });
});

describe('missingFields', () => {
  test('a risk to mitigate needs its hazard, guard and check', () => {
    const [risk] = parseRisks('### Risk: Thin\n- **Hazard:** something\n', 'f');
    expect(missingFields(risk!)).toEqual(['guard', 'check']);
  });

  test('an unmitigated risk needs only its hazard', () => {
    expect(missingFields(parseRisks(RISKS, 'f')[1]!)).toEqual([]);
  });
});

describe('unansweredRisks', () => {
  const risks = parseRisks(RISKS, 'f');

  test('names a risk the design does not mention', () => {
    expect(unansweredRisks(risks, '## Risks / Trade-offs\nNone.').map((r) => r.name)).toEqual([
      'Edited requirement stays accepted',
    ]);
  });

  test('a mention by name answers it, whatever its case and emphasis', () => {
    expect(unansweredRisks(risks, '- **Edited requirement  stays ACCEPTED** → hash check')).toEqual([]);
  });

  test('an unmitigated risk needs no answer', () => {
    expect(unansweredRisks(risks, '').map((r) => r.name)).not.toContain('Archive loses deferred work');
  });
});

const TASKS = `## 3. Guards

- [x] 3.1 (guard: Edited requirement stays accepted) Test that editing an
      accepted requirement sends it back to pending
      (shown red: reverted the hash check — 1 failure)
- [x] 3.2 (guard: Other risk) Test it
- [ ] 3.3 Plain task
`;

describe('guard tasks', () => {
  test('finds each guard task, and its proof on a continuation line', () => {
    expect(guardTasks(TASKS)).toMatchObject([
      { risk: 'Edited requirement stays accepted', done: true, shownRed: true },
      { risk: 'Other risk', done: true, shownRed: false },
    ]);
  });

  test('a guard ticked without being shown red is unproven', () => {
    expect(unprovenGuards(TASKS).map((g) => g.risk)).toEqual(['Other risk']);
  });

  test('an empty proof is no proof', () => {
    expect(unprovenGuards('- [x] 1.1 (guard: A) Test (shown red: )')).toHaveLength(1);
  });

  test('a risk with no guard task is unguarded; an unmitigated one never is', () => {
    const risks = parseRisks(RISKS, 'f');
    expect(unguardedRisks(risks, TASKS)).toEqual([]);
    expect(unguardedRisks(risks, '- [ ] 1.1 Something').map((r) => r.name)).toEqual([
      'Edited requirement stays accepted',
    ]);
  });
});

describe('task progress with guards', () => {
  test('an unproven guard counts as open, not done', () => {
    expect(taskProgress(TASKS)).toEqual({ total: 3, done: 1, deferred: 0, open: 2, unproven: 1, applied: false });
  });

  test('recording the proof finishes it', () => {
    const proven = TASKS.replace('(guard: Other risk) Test it', '(guard: Other risk) Test it (shown red: removed the lock)')
      .replace('- [ ] 3.3', '- [x] 3.3');
    expect(taskProgress(proven).applied).toBe(true);
  });

  test('recording the proof is implementing, not changing the accepted plan', () => {
    const before = '- [ ] 3.2 (guard: Other risk) Test it\n';
    const after = '- [x] 3.2 (guard: Other risk) Test it (shown red: removed the lock)\n';
    expect(hashDocument(after)).toBe(hashDocument(before));
    expect(hashDocument('- [ ] 3.2 (guard: Another risk) Test it\n')).not.toBe(hashDocument(before));
  });
});

describe('a risk in the review', () => {
  test('is named a risk, and says what it lacks', () => {
    const [risk] = parseRisks('### Risk: Thin\n- **Hazard:** something breaks\n', '/c/risks.md');
    const out = renderRequirement(
      { item: risk!, state: 'pending', review: { state: 'pending', hash: null, reviewedAt: null }, drifted: false },
      { index: 1, total: 1, summary: { total: 1, accepted: 0, rejected: 0, deferred: 0, pending: 1, drifted: 0, complete: false } },
    );
    expect(out).toContain('risk 1 of 1');
    expect(out).toContain('Risk: Thin');
    expect(out).toContain('! missing guard, check');
  });
});
