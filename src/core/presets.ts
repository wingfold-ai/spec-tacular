/**
 * Follow-ups that need no model: the obvious next questions for common
 * answers, shown the moment an answer is saved.
 *
 * "Python" always leaves the same things open — the version, the package
 * manager, the test runner, the framework — and waiting 10 to 30 seconds for a
 * model to say so is waiting for nothing. So a small, deliberately boring
 * table answers the common cases at once, and the advisor refines behind it:
 * it may add questions the table did not think of and replace these options
 * with better ones, but never under a developer who already chose.
 *
 * Two rules keep the table honest:
 *   - No version numbers. Which release is current is a fact that goes stale;
 *     a version question comes from here with no options, and its options
 *     come from the advisor, which looks them up.
 *   - It proposes, it never decides — exactly like the advisor. Everything
 *     here is an option to pick, never an answer written for anyone.
 */

import type { AdviceOption, FollowUp } from './advisor.ts';
import type { GuidedQuestion } from './foundation.ts';

export interface PresetRule {
  /** The question whose answer it reacts to, by its text. */
  question: RegExp;
  /** The answers it reacts to. */
  answer: RegExp;
  /** Not when the answer already says this — "Python 3.14" has its version. */
  unless?: RegExp;
  /** Questions to ask next, inserted after the answer. */
  followUps?: FollowUp[];
  /** Options for questions already in the Foundation, by their text. */
  options?: { question: RegExp; options: AdviceOption[] }[];
}

const opt = (label: string, detail: string, recommended = false): AdviceOption => ({ label, detail, recommended });

const LANGUAGE = /language|runtime/i;
const TOOLING = /package manager|test runner|linter|formatter/i;
const FRAMEWORK = /framework/i;
const DATASTORE = /datastore|database/i;
const STYLE = /architecture style/i;
const LAYERS = /layers or modules/i;

/** A version question, left for the advisor to look up. */
const version = (what: string): FollowUp => ({
  ask: `Which ${what} version?`,
  why: 'Tooling, CI and every dependency are pinned against it.',
  options: [],
});

export const PRESETS: PresetRule[] = [
  // --- languages -----------------------------------------------------------
  {
    question: LANGUAGE,
    answer: /\bpython\b/i,
    unless: /\d/,
    followUps: [version('Python')],
  },
  {
    question: LANGUAGE,
    answer: /\bpython\b/i,
    options: [
      {
        question: TOOLING,
        options: [
          opt('uv, pytest, ruff (lint + format)', 'fast, one tool for envs and locking', true),
          opt('poetry, pytest, ruff (lint + format)', 'mature lockfile workflow'),
          opt('pip + venv, pytest, ruff (lint + format)', 'no extra tooling to install'),
        ],
      },
      {
        question: FRAMEWORK,
        options: [
          opt('FastAPI', 'typed HTTP APIs, async, OpenAPI for free', true),
          opt('Django', 'batteries included: ORM, admin, auth'),
          opt('Flask', 'minimal, add pieces as needed'),
          opt('none', 'a library, CLI or script'),
        ],
      },
    ],
  },
  {
    question: LANGUAGE,
    answer: /\b(typescript|javascript|node(\.js)?|ts|js)\b/i,
    unless: /\b(node|bun|deno)\b/i,
    followUps: [{
      ask: 'Which runtime runs it: Node.js, Bun or Deno?',
      why: 'Decides the package manager, test runner and which APIs exist.',
      options: [
        opt('Node.js (LTS)', 'the default; widest library support', true),
        opt('Bun', 'fast, built-in test runner and bundler'),
        opt('Deno', 'secure by default, built-in tooling'),
      ],
    }],
  },
  {
    question: LANGUAGE,
    answer: /\b(typescript|javascript|node(\.js)?|bun|deno)\b/i,
    options: [
      {
        question: TOOLING,
        options: [
          opt('pnpm, vitest, eslint, prettier', 'the common Node.js setup', true),
          opt('bun, bun test, eslint, prettier', 'on Bun: one tool for most of it'),
          opt('npm, vitest, biome (lint + format)', 'fewer tools to configure'),
          opt('deno, deno test, deno lint, deno fmt', 'on Deno: all built in'),
        ],
      },
      {
        question: FRAMEWORK,
        options: [
          opt('Hono', 'small, typed, runs on every runtime', true),
          opt('Fastify', 'fast, schema-based Node.js server'),
          opt('Express', 'the most widely known, minimal'),
          opt('Next.js', 'full-stack React with server rendering'),
          opt('none', 'a library, CLI or script'),
        ],
      },
    ],
  },
  {
    question: LANGUAGE,
    answer: /\brust\b/i,
    followUps: [
      {
        ask: 'Which Rust edition, and the minimum supported Rust version (MSRV)?',
        why: 'Edition and MSRV decide which language features and crates are allowed.',
        options: [],
      },
      {
        ask: 'Which async runtime, if any?',
        why: 'Most networking crates are written for one runtime.',
        options: [
          opt('tokio', 'the ecosystem default for async I/O', true),
          opt('none (synchronous)', 'simplest, fine for CLIs and batch work'),
          opt('smol', 'small and simple'),
        ],
      },
    ],
    options: [{
      question: TOOLING,
      options: [
        opt('cargo, cargo test, clippy, rustfmt', 'the standard toolchain', true),
        opt('cargo, cargo-nextest, clippy, rustfmt', 'faster, clearer test runs'),
      ],
    }],
  },
  {
    question: LANGUAGE,
    answer: /\b(go|golang)\b/i,
    unless: /\d/,
    followUps: [version('Go')],
    options: [{
      question: TOOLING,
      options: [
        opt('go modules, go test, golangci-lint, gofmt', 'the standard toolchain plus the usual linter', true),
        opt('go modules, go test, go vet, gofmt', 'nothing beyond the Go distribution'),
      ],
    }],
  },
  {
    question: LANGUAGE,
    answer: /\b(java|kotlin)\b/i,
    followUps: [{
      ask: 'Which build tool: Gradle or Maven?',
      why: 'Decides how dependencies, builds and tests are declared.',
      options: [
        opt('Gradle (Kotlin DSL)', 'flexible, the Kotlin default', true),
        opt('Maven', 'conventional, declarative XML'),
      ],
    }],
  },

  // --- datastores ----------------------------------------------------------
  {
    question: DATASTORE,
    answer: /\b(postgres(ql)?|mysql|mariadb|sqlite|sql server|mssql|oracle)\b/i,
    unless: /migrat|alembic|drizzle|prisma|flyway|liquibase|sqlx|dbmate|atlas|knex|diesel|ecto|goose/i,
    followUps: [{
      ask: 'How are schema migrations written and applied?',
      why: 'Every change that touches data follows this.',
      options: [
        opt('Versioned migration files, applied by a tool', 'reviewed like code, replayable anywhere', true),
        opt('Generated by the ORM from the models, then reviewed', 'less to write, check what it generates'),
        opt('Hand-applied SQL', 'only for a throwaway or single-user database'),
      ],
    }],
  },
  {
    question: DATASTORE,
    answer: /\bmongo(db)?\b/i,
    followUps: [{
      ask: 'How are document shapes validated?',
      why: 'Without a schema, nothing stops two shapes of the same record.',
      options: [
        opt('In the application, one schema per collection', 'validated on every write', true),
        opt('MongoDB JSON Schema validators', 'enforced by the database'),
        opt('Not validated', 'only for prototypes'),
      ],
    }],
  },

  // --- architecture --------------------------------------------------------
  {
    question: STYLE,
    answer: /hexagonal|ports and adapters|ports & adapters/i,
    options: [{
      question: LAYERS,
      options: [
        opt('domain ← application (ports) ← adapters ← main', 'the core never imports an adapter', true),
        opt('domain + ports in core/, one package per adapter', 'adapters swappable per deployment'),
      ],
    }],
  },
  {
    question: STYLE,
    answer: /\bclean\b|onion/i,
    options: [{
      question: LAYERS,
      options: [
        opt('entities ← use cases ← interface adapters ← frameworks', 'dependencies point inwards only', true),
        opt('domain ← application ← infrastructure ← presentation', 'the same rule, in onion terms'),
      ],
    }],
  },
  {
    question: STYLE,
    answer: /layered|n-tier|three-tier|mvc/i,
    options: [{
      question: LAYERS,
      options: [
        opt('presentation → application → domain → data access', 'each layer calls only the one below', true),
        opt('controllers → services → repositories', 'the classic web-app split'),
      ],
    }],
  },
  {
    question: STYLE,
    answer: /vertical slice|feature slice|by feature/i,
    followUps: [{
      ask: 'What may slices share, and what stays inside one?',
      why: 'Slices that share freely become a layered app again.',
      options: [
        opt('Only a small shared kernel: types and utilities', 'each slice owns its data access and logic', true),
        opt('A shared domain model; handlers per slice', 'one model, many entry points'),
      ],
    }],
  },
  {
    question: STYLE,
    answer: /micro-?services?/i,
    followUps: [{
      ask: 'How do the services talk to each other?',
      why: 'Decides coupling, failure modes and how changes are rolled out.',
      options: [
        opt('HTTP/JSON APIs', 'simple, synchronous, easy to debug', true),
        opt('Asynchronous messages (a queue or event bus)', 'decoupled, eventually consistent'),
        opt('gRPC', 'typed contracts, efficient'),
      ],
    }],
  },
];

export interface PresetMatch {
  followUps: FollowUp[];
  options: { question: RegExp; options: AdviceOption[] }[];
}

/** Everything the table has for this answer, follow-ups deduplicated by text. */
export function matchPresets(question: GuidedQuestion, answer: string, rules: PresetRule[] = PRESETS): PresetMatch {
  const followUps: FollowUp[] = [];
  const options: PresetMatch['options'] = [];
  for (const rule of rules) {
    if (!rule.question.test(question.item.name) || !rule.answer.test(answer)) continue;
    if (rule.unless?.test(answer)) continue;
    for (const f of rule.followUps ?? []) {
      if (!followUps.some((x) => x.ask === f.ask)) followUps.push(f);
    }
    for (const o of rule.options ?? []) {
      if (!options.some((x) => x.question.source === o.question.source)) options.push(o);
    }
  }
  return { followUps, options };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The options to show when new ones arrive for a question on screen.
 *
 * Nobody chose yet: the new ones, as they came. Somebody has an option
 * selected that the new list lacks: it stays, first, so the thing under
 * their cursor never disappears or changes into something else.
 */
export function mergeOptions(
  shown: AdviceOption[],
  incoming: AdviceOption[],
  selected: string | null,
): AdviceOption[] {
  if (selected === null || incoming.some((o) => same(o.label, selected))) return incoming;
  const kept = shown.find((o) => same(o.label, selected));
  if (!kept) return incoming;
  const recommended = incoming.some((o) => o.recommended);
  return [{ ...kept, recommended: kept.recommended && !recommended }, ...incoming];
}
