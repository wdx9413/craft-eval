import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stdin } from 'node:process';

let input = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { input += chunk; });
stdin.on('end', async () => {
  const id = input.match(/SYNTHETIC_FIXTURE ([a-z0-9-]+)/u)?.[1];
  const fixture = JSON.parse(await readFile('cases.json', 'utf8'));
  const item = fixture.cases.find((candidate) => candidate.id === id);
  if (!item) process.exit(2);
  const sections = item.expected_sections.map((section) => `## ${section}`).join('\n\n');
  const receipts = item.observations.map((source) =>
    `- ${source.source_id}: ${source.url} (accessed_at: ${source.accessed_at}; content_digest: ${source.content_digest})\n  Observation: ${source.text}`,
  ).join('\n');
  const failure = item.access_error ? `\n\nAccess status: ${item.access_error}\nNo source observation was recorded.` : '';
  const markdown = `# Synthetic report: ${id}\n\n${sections}\n\n${receipts}${failure}\n\nFixture-only result; source receipts do not imply independent verification.\n`;
  await mkdir('outputs', { recursive: true });
  await writeFile(`outputs/${id}.md`, markdown, 'utf8');
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`);
});
