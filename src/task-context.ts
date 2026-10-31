import { createHash } from 'node:crypto';

export interface TaskContext {
  id: string;
  text: string;
}

export interface TaskInputReceipt {
  task_prompt_sha256: string;
  submitted_prompt_sha256: string;
  context_id: string | null;
  context_sha256: string | null;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** An explicit intervention, never an implicit read from a developer's knowledge directory. */
export function validateTaskContext(value: unknown): TaskContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('subject.context must be an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['id', 'text'].includes(key))) throw new Error('subject.context contains unsupported fields');
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(record.id)) throw new Error('subject.context.id is invalid');
  if (typeof record.text !== 'string' || !record.text.trim() || record.text.includes('\0') || Buffer.byteLength(record.text, 'utf8') > 64 * 1024) throw new Error('subject.context.text must contain at most 64 KiB of nonempty text');
  return { id: record.id, text: record.text };
}

/** The receipt proves bytes submitted to the adapter, not that a model used or understood them. */
export function prepareTaskInput(task: string, context?: TaskContext): { prompt: string; receipt: TaskInputReceipt } {
  const prompt = context === undefined ? task : `Evaluation context (JSON):\n${JSON.stringify(context)}\n\nTask:\n${task}`;
  return { prompt, receipt: { task_prompt_sha256: sha256(task), submitted_prompt_sha256: sha256(prompt),
    context_id: context?.id ?? null, context_sha256: context === undefined ? null : sha256(context.text) } };
}
