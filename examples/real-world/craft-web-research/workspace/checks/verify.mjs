import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile('cases.json', 'utf8'));
for (const item of fixture.cases) {
  const report = await readFile(`outputs/${item.id}.md`, 'utf8');
  for (const expected of item.expected_sections) assert.ok(report.includes(expected), `${item.id} missing ${expected}`);
  for (const forbidden of item.forbidden_claims) assert.ok(!report.includes(forbidden), `${item.id} claims ${forbidden}`);
  for (const source of item.observations) {
    assert.ok(report.includes(source.url), `${item.id} missing source URL`);
    assert.ok(report.includes(source.accessed_at), `${item.id} missing access time`);
    assert.ok(report.includes(source.content_digest), `${item.id} missing content digest`);
  }
  assert.ok(report.includes('do not imply independent verification'), `${item.id} overstates evidence`);
}
