/**
 * What an architecture style already decides.
 *
 * "Clean Architecture" is not only a name: it fixes which way imports point,
 * what the layers are called, where I/O may happen and where interfaces sit.
 * Asking the developer each of those afterwards, open-ended, asks them to
 * restate their own answer — and a model is not needed to know the rule
 * either. So a small table maps the common styles to the answers that follow
 * from them, filled in the instant the style is saved, marked ⇐ derived. The
 * advisor may then refine them for the project (its language, its folder
 * names), like it refines the preset table's options (core/presets.ts).
 *
 * The same rule as everywhere in the setup: derived answers are proposals,
 * pre-selected and confirmed with enter, never written for anyone.
 */

import type { GuidedQuestion } from './foundation.ts';

/** The architecture style question, by its text. */
export const STYLE_QUESTION = /architecture style/i;

/** Questions a style settles, by their text. */
export const LAYERS_QUESTION = /layers or modules|may depend on|import direction/i;
export const RULES_QUESTION = /business rules live/i;

export interface StyleDerivation {
  /** How the style is named in the reason, e.g. `Clean Architecture`. */
  style: string;
  /** The answers that name it. The first style that matches wins. */
  answer: RegExp;
  /** The layers and which way dependencies point, with folder names. */
  layers: string;
  /** Where business rules live, and where I/O happens instead. */
  rules: string;
}

/**
 * The styles, most specific first: "clean hexagonal" is hexagonal, a
 * "layered MVC app" is MVC.
 */
export const STYLE_DERIVATIONS: StyleDerivation[] = [
  {
    style: 'hexagonal (ports & adapters)',
    answer: /hexagonal|ports\s*(and|&)\s*adapters/i,
    layers:
      'core (domain + application) ← ports ← adapters ← main. Adapters depend on the core, never ' +
      'the reverse: the core defines the ports (interfaces) it offers and needs; driving adapters ' +
      '(HTTP, CLI) call them, driven adapters (database, queues, clocks) implement them; main wires ' +
      'adapters to ports. Folders: core/domain, core/application, core/ports, adapters/<in|out>/<tech>.',
    rules:
      'In the core: domain model and application services. It imports no adapter, framework, ' +
      'HTTP, SQL, file system or clock — every I/O goes through a port the core owns and an ' +
      'adapter implements, injected at startup.',
  },
  {
    style: 'Clean Architecture',
    answer: /\bclean\b|onion/i,
    layers:
      'entities ← use cases ← interface adapters ← frameworks & drivers. Dependencies point ' +
      'inward only — frameworks/infrastructure → adapters → use cases → entities; an inner layer ' +
      'never imports an outer one, not even its types. Folders: domain/ (entities), application/ ' +
      '(use cases and the ports they own), adapters/ (controllers, presenters, gateways), ' +
      'infrastructure/ (framework, database, HTTP, config); main wires them together.',
    rules:
      'In domain/ (entities) and application/ (use cases). No I/O there: HTTP, SQL, file system, ' +
      'clocks and framework types stay in adapters/ and infrastructure/. Use cases depend on ' +
      'interfaces they define; outer layers implement them (dependency inversion at every boundary).',
  },
  {
    style: 'modular monolith',
    answer: /modular\s*monolith|modulith/i,
    layers:
      'One deployable, split into modules by business capability (modules/<name>). A module is ' +
      'used only through its public API (its index); never import another module\'s internals. ' +
      'Dependencies between modules are one-way and acyclic; shared code lives in a small shared/ ' +
      'kernel that depends on no module.',
    rules:
      'Inside the module that owns the capability. A module owns its data — no other module reads ' +
      'its tables — and keeps I/O (HTTP handlers, persistence) at its edges, business logic in plain ' +
      'code at its centre.',
  },
  {
    style: 'vertical slices',
    answer: /vertical\s*slice|feature\s*slice|by\s*feature|feature\s*folders/i,
    layers:
      'One folder per feature or use case (features/<feature>), holding its entry point, logic and ' +
      'data access. Slices never import each other; anything two slices share moves to a small ' +
      'shared/ kernel, which imports no slice.',
    rules:
      'In the slice that owns the use case, as plain functions its handler calls. The handler and ' +
      'the slice\'s data access are where I/O happens; the logic between them takes and returns ' +
      'plain values.',
  },
  {
    style: 'MVC',
    answer: /\bmvc\b|model[\s-]*view[\s-]*controller/i,
    layers:
      'models ← controllers → views. Controllers depend on models and views; views read models but ' +
      'never change them; models depend on neither. Folders: models/, views/, controllers/.',
    rules:
      'In the models (or services the models use). Controllers only translate a request, call the ' +
      'model and pick a view; views hold no logic beyond display. HTTP stays in controllers, ' +
      'persistence in models or their repositories.',
  },
  {
    style: 'layered',
    answer: /layered|n-tier|three-tier|3-tier/i,
    layers:
      'presentation → application → domain → data access. Each layer calls only the layer below ' +
      'it, never one above. Folders: presentation/, application/, domain/, data/.',
    rules:
      'In domain/ (and application/ for workflows). Presentation holds no rules, only input and ' +
      'output; data access holds no rules, only persistence. I/O happens at the top (HTTP, UI) and ' +
      'the bottom (database), never in the domain.',
  },
];

export interface Derivation {
  /** The question it answers, by its text. */
  question: RegExp;
  answer: string;
  /** Which earlier answer it follows from, in one line. */
  reason: string;
}

/** The answers an architecture style decides, when this is the style question. */
export function deriveFromArchitecture(question: GuidedQuestion, answer: string): Derivation[] {
  if (!STYLE_QUESTION.test(question.item.name)) return [];
  const style = STYLE_DERIVATIONS.find((s) => s.answer.test(answer));
  if (!style) return [];
  return [
    { question: LAYERS_QUESTION, answer: style.layers, reason: `${style.style}: the dependency rule it defines` },
    { question: RULES_QUESTION, answer: style.rules, reason: `${style.style}: where rules and I/O live` },
  ];
}
