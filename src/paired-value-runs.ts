/**
 * Deep module for the value-ledger paired runs.
 *
 * The seam is one function: `runPairedValueCases`. A new paired benefit or
 * restraint scenario is declared as data in `core/eval-cases.ts`; nothing in
 * the suite runner needs to change for it. All the fiddly parts — retry policy,
 * hard-constraint handling, turn accounting, byte grading, and the joint
 * degenerate-policy guard — live here rather than being repeated per case.
 */
import {
  CONTEXT_SUPPLY_AID_LIMIT, CONTEXT_SUPPLY_FACT, CONTEXT_SUPPLY_MARKER,
  contextSupplyAidedPrompt, contextSupplyControlPrompt, MEMORY_SUPPLY_FACT, MEMORY_SUPPLY_MARKER,
  memorySupplyAidedPrompt, memorySupplyControlPrompt, PROACTIVE_ACT, PROACTIVE_SCENARIOS,
  PROACTIVE_SKIP, proactivePrompt,
} from "./eval-cases.ts";
import type { EvalTrial } from "./model.ts";

export interface PairedRunner {
  ask: (prompt: string) => Promise<EvalTrial>;
  /** Called with the exact number of model turns this run performed. */
  addTurns: (turns: number) => void;
  /** Whether the given case id is in the selected scope. */
  inScope: (id: string) => boolean;
  /** Optional real-kernel hook that returns the Memory aid; null means unavailable. */
  memoryAid: (() => Promise<{ text: string; hits: number }>) | null;
  /** Credential gap, if any: every selected model case is marked unobserved. */
  gap: string | null;
}

export interface PairedOutcome {
  id: string;
  /** null means unobserved (inconclusive), never a silent pass. */
  passed: boolean | null;
  reason: string;
}

const PAIR_ATTEMPTS = 3;
const PAIR_MIN_SUCCESSES = 2;

/** Three paired observations; a majority of clean attributions passes, but any
 *  baseline leakage fails immediately because it invalidates the causal claim. */
async function observePair(runner: PairedRunner, controlPrompt: string, aidedPrompt: string, marker: string) {
  let successes = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= PAIR_ATTEMPTS; attempt += 1) {
    runner.addTurns(2);
    attempts = attempt;
    const baseline = await runner.ask(controlPrompt);
    const aided = await runner.ask(aidedPrompt);
    if (baseline.text.includes(marker)) {
      return { passed: false, attempts, successes, baselineLeaked: true, lastAidedCarried: aided.text.includes(marker) };
    }
    if (aided.text.includes(marker)) successes += 1;
  }
  return { passed: successes >= PAIR_MIN_SUCCESSES, attempts, successes, baselineLeaked: false, lastAidedCarried: successes > 0 };
}

function pairedReason(extra: string, paired: { attempts: number; successes: number; baselineLeaked: boolean; lastAidedCarried: boolean }): string {
  return `${extra} successes=${paired.successes}/${paired.attempts} baseline_leaked=${String(paired.baselineLeaked)} aided_carried=${String(paired.lastAidedCarried)}`;
}

/**
 * Run every declared value pair and return one outcome per selected case.
 * The joint guard is applied across the proactive set as a whole: a policy
 * that is always silent or always nudging fails every case in that set.
 */
export async function runPairedValueCases(runner: PairedRunner): Promise<PairedOutcome[]> {
  const outcomes: PairedOutcome[] = [];

  const contextCases = [
    {
      id: "context_supply.supplied_context_replaces_explanation",
      control: contextSupplyControlPrompt(),
      aided: contextSupplyAidedPrompt(CONTEXT_SUPPLY_FACT),
      marker: CONTEXT_SUPPLY_MARKER,
      extra: `aid_chars=${contextSupplyAidedPrompt(CONTEXT_SUPPLY_FACT).length - contextSupplyControlPrompt().length}/${CONTEXT_SUPPLY_AID_LIMIT}`,
    },
    {
      id: "context_supply.memory_hit_replaces_repetition",
      control: memorySupplyControlPrompt(),
      aided: memorySupplyAidedPrompt(MEMORY_SUPPLY_FACT),
      marker: MEMORY_SUPPLY_MARKER,
      extra: "",
    },
  ];

  for (const scenario of contextCases) {
    if (!runner.inScope(scenario.id)) continue;
    if (runner.gap) { outcomes.push({ id: scenario.id, passed: null, reason: runner.gap }); continue; }
    try {
      let control = scenario.control;
      let aided = scenario.aided;
      let extra = scenario.extra;
      if (scenario.id === "context_supply.memory_hit_replaces_repetition") {
        if (!runner.memoryAid) throw new Error("Memory kernel is unavailable");
        const memory = await runner.memoryAid();
        aided = memorySupplyAidedPrompt(memory.text);
        const aidChars = aided.length - control.length;
        extra = `memory_hits=${memory.hits} kernel_carried=${String(memory.text.includes(MEMORY_SUPPLY_MARKER))} aid_chars=${aidChars}/${CONTEXT_SUPPLY_AID_LIMIT}`;
        if (!memory.text.includes(MEMORY_SUPPLY_MARKER) || aidChars > CONTEXT_SUPPLY_AID_LIMIT) {
          outcomes.push({ id: scenario.id, passed: false, reason: `${extra} kernel did not supply the bounded rule` });
          continue;
        }
      }
      const paired = await observePair(runner, control, aided, scenario.marker);
      outcomes.push({ id: scenario.id, passed: paired.passed, reason: pairedReason(extra, paired) });
    } catch (error) {
      outcomes.push({ id: scenario.id, passed: null, reason: (error as Error).message });
    }
  }

  const selectedProactive = PROACTIVE_SCENARIOS.filter((scenario) => runner.inScope(scenario.id));
  const replies: Record<string, string> = {};
  for (const scenario of selectedProactive) {
    if (runner.gap) { outcomes.push({ id: scenario.id, passed: null, reason: runner.gap }); continue; }
    try {
      runner.addTurns(1);
      const trial = await runner.ask(proactivePrompt(scenario));
      replies[scenario.id] = trial.text.trim().toLowerCase();
    } catch (error) {
      outcomes.push({ id: scenario.id, passed: null, reason: (error as Error).message });
    }
  }
  const observed = selectedProactive.filter((scenario) => replies[scenario.id] !== undefined);
  if (observed.length) {
    const decisions = observed.map((scenario) => replies[scenario.id]!);
    const degenerate = decisions.every((decision) => decision === PROACTIVE_SKIP)
      || decisions.every((decision) => decision === PROACTIVE_ACT);
    for (const scenario of observed) {
      const reply = replies[scenario.id]!;
      const passed = reply === scenario.expected && !degenerate;
      outcomes.push({ id: scenario.id, passed,
        reason: `reply=${JSON.stringify(reply)} expected=${scenario.expected} degenerate=${String(degenerate)} decisions=${decisions.join(",")}` });
    }
  }
  return outcomes;
}
