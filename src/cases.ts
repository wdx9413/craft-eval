/**
 * Evaluation tasks with machine-checkable answers.
 *
 * Each task's expected value is a fixed string, so a verdict comes from byte
 * comparison and never from a model's opinion of its own work.
 *
 * These used to be declared per script. `ARITHMETIC` in particular existed three
 * times: as a case object in `eval-run`, and in `eval-suite-run` as a separate
 * `MAX_PASSED = "391"` constant plus a repeated prompt literal. One definition now,
 * so the prompt and its expected answer cannot drift apart.
 */

/** One deterministic task: a prompt whose correct answer is a fixed string. */
export interface EvalTask {
  id: string;
  prompt: string;
  /** Exact expected output, compared as bytes. */
  expected: string;
}

/**
 * Also the end-to-end case in the held-out suite (`e2e.deterministic_task_completes`).
 */
export const ARITHMETIC: EvalTask = {
  id: "arithmetic",
  prompt: "What is 17 * 23? Reply with the number only, no punctuation.",
  expected: "391",
};

/** Tasks the local model answers reliably, so a failure here is a real signal. */
export const DETERMINISTIC_TASKS: readonly EvalTask[] = [
  ARITHMETIC,
  { id: "reverse", prompt: "Reverse the string 'craft'. Reply with the reversed string only.", expected: "tfarc" },
  { id: "sort", prompt: "Sort these numbers ascending: 5 3 9 1. Reply with them space-separated, nothing else.", expected: "1 3 5 9" },
  { id: "json", prompt: 'Reply with exactly this JSON and nothing else: {"ok":true}', expected: '{"ok":true}' },
];

/**
 * Three independent tasks sharing one failure shape.
 *
 * Exact character counting is used deliberately: the model cannot verify the count
 * internally, so it fails reproducibly across distinct tasks. That makes recurrence
 * genuine rather than planted — the expected values are correct and the model's
 * answers are wrong.
 */
export const COUNTING_TASKS: readonly EvalTask[] = [
  { id: "count-1", prompt: "How many times does the letter 'r' appear in 'strawberry'? Reply with the number only.", expected: "3" },
  { id: "count-2", prompt: "How many times does the letter 'l' appear in 'parallel'? Reply with the number only.", expected: "3" },
  { id: "count-3", prompt: "How many times does the letter 's' appear in 'assessment'? Reply with the number only.", expected: "4" },
];
