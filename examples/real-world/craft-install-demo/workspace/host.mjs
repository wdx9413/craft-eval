import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stdin } from 'node:process';

let input = '';
stdin.setEncoding('utf8');
stdin.on('data', chunk => { input += chunk; });
stdin.on('end', async () => {
  const step = input.match(/DEMO_STEP ([a-z-]+)/u)?.[1];
  const readJson = async (name, fallback) => readFile(name, 'utf8').then(JSON.parse).catch(() => fallback);
  const state = await readJson('state.json', { preferences: [] });
  if (step === 'configure-model') {
    state.model = { provider: 'synthetic-fixture', configured: true, key: '[REDACTED]' };
    await writeFile('model-setup.json', JSON.stringify(state.model, null, 2));
  } else if (step === 'research-and-deliver') {
    const pages = await readFile('pages/competitors.md', 'utf8');
    await mkdir('deliverables', { recursive: true });
    await writeFile('deliverables/comparison.md', '# Competitor comparison\n\n| Competitor | Price | Source |\n|---|---:|---|\n| North | 19 | pages/competitors.md#page-north |\n| South | 24 | pages/competitors.md#page-south |\n');
    state.source_digest = pages.length;
  } else if (step === 'protect-user-edit') {
    const document = await readFile('deliverables/comparison.md', 'utf8');
    await writeFile('deliverables/comparison.md', document + '\nUser edit: South has higher priority for follow-up.\n');
    state.user_edit = 'South has higher priority for follow-up.';
  } else if (step === 'restart-and-resume') {
    const document = await readFile('deliverables/comparison.md', 'utf8');
    if (!document.includes(state.user_edit)) throw new Error('user edit was overwritten after restart');
    state.resumed = true;
  } else if (step === 'append-competitor') {
    const document = await readFile('deliverables/comparison.md', 'utf8');
    await writeFile('deliverables/comparison.md', document.replace('|---|---:|---|', '|---|---:|---|\n| West | 17 | pages/competitors.md#page-west |'));
  } else if (step === 'project-correction') {
    state.preferences.push({ id: 'price-order', value: 'ascending', status: 'active' });
  } else if (step === 'undo-correction') {
    state.preferences = state.preferences.map(item => ({ ...item, status: 'revoked' }));
  } else {
    process.exitCode = 2;
    return;
  }
  await writeFile('state.json', JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
});
