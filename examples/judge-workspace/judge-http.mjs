// Real-model judge: calls an OpenAI-compatible gateway and parses a 0..1 score.
//
// Required environment:
//   CRAFT_EVAL_JUDGE_ENDPOINT   e.g. http://127.0.0.1:3425/v1/chat/completions
//   CRAFT_EVAL_JUDGE_MODEL      e.g. group/free
//   CRAFT_EVAL_JUDGE_API_KEY    bearer token (or set CRAFT_EVAL_JUDGE_API_KEY_ENV
//                               to the name of a variable that holds it)
//   CRAFT_EVAL_JUDGE_ANSWER     injected by craft-eval: path to the answer file
//   CRAFT_EVAL_JUDGE_RUBRIC     injected by craft-eval: grading rubric text
//
// Missing configuration exits non-zero with the missing item named, so craft-eval
// records an environment gap instead of a fabricated score.
import { readFileSync } from 'node:fs';

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(JSON.stringify({ error: `missing environment variable: ${name}` }));
    process.exit(2);
  }
  return value;
};

const endpoint = required('CRAFT_EVAL_JUDGE_ENDPOINT');
const model = required('CRAFT_EVAL_JUDGE_MODEL');
const answerPath = required('CRAFT_EVAL_JUDGE_ANSWER');
const rubric = process.env.CRAFT_EVAL_JUDGE_RUBRIC ?? '';
const keyEnvName = process.env.CRAFT_EVAL_JUDGE_API_KEY_ENV ?? 'CRAFT_EVAL_JUDGE_API_KEY';
const apiKey = required(keyEnvName);

let answer;
try {
  answer = readFileSync(answerPath, 'utf8');
} catch (error) {
  console.error(JSON.stringify({ error: `cannot read answer: ${error.message}` }));
  process.exit(2);
}

const system = [
  'You are an evaluation judge. Grade the answer against the rubric.',
  'Respond with exactly one JSON object and nothing else:',
  '{"score": <number 0..1>, "reason": "<one sentence>"}',
  'score 1 means the answer fully satisfies the rubric; 0 means it does not at all.',
  'Never invent facts the answer does not contain.',
].join('\n');
const user = `Rubric:\n${rubric}\n\nAnswer to grade:\n${answer}`;

let response;
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 512,
      temperature: 0,
    }),
  });
} catch (error) {
  console.error(JSON.stringify({ error: `gateway unreachable: ${error.message}` }));
  process.exit(2);
}

if (!response.ok) {
  const body = await response.text().catch(() => '');
  console.error(JSON.stringify({ error: `gateway returned ${response.status}: ${body.slice(0, 200)}` }));
  process.exit(2);
}

let payload;
try {
  payload = await response.json();
} catch (error) {
  console.error(JSON.stringify({ error: `gateway returned non-JSON: ${error.message}` }));
  process.exit(2);
}

const content = payload.choices?.[0]?.message?.content;
if (typeof content !== 'string') {
  console.error(JSON.stringify({ error: 'gateway response has no message content' }));
  process.exit(2);
}

// The model may wrap the JSON in prose or code fences; take the first object.
const match = content.match(/\{[\s\S]*\}/);
if (match === null) {
  console.error(JSON.stringify({ error: `model output has no JSON object: ${content.slice(0, 200)}` }));
  process.exit(2);
}

let verdict;
try {
  verdict = JSON.parse(match[0]);
} catch (error) {
  console.error(JSON.stringify({ error: `model JSON unparseable: ${error.message}` }));
  process.exit(2);
}

const score = typeof verdict.score === 'number' && Number.isFinite(verdict.score) && verdict.score >= 0 && verdict.score <= 1
  ? verdict.score
  : null;
if (score === null) {
  console.error(JSON.stringify({ error: `model score out of range or missing: ${JSON.stringify(verdict.score)}` }));
  process.exit(2);
}

process.stdout.write(JSON.stringify({ score, reason: typeof verdict.reason === 'string' ? verdict.reason.slice(0, 300) : '' }));
