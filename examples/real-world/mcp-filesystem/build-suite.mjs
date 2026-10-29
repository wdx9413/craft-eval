// Generate the 22-case filesystem suite.
//
// Each case runs the same probe driver in its own workspace, so the driver's
// outputs/probe-result.json holds exactly one record (plus __init/__tools).
// The checks below grade that record: a negative case asserts is_error, a
// positive one asserts success and the observable effect.
import { writeFileSync } from 'node:fs';

const SERVER = '{{subjects}}\\mcp-servers\\src\\filesystem\\dist\\index.js';
// process.execPath is the embedding host (e.g. a desktop app) when this script
// runs under one, which would make argv[0] an application rather than node.
const NODE = process.env.CRAFT_EVAL_NODE_BINARY ?? 'node';

/** Every case: run the probe in its own workspace, then assert on its record.
 *
 * `id` names the case; `probe` names the directory under probes/ and workspaces/
 * that supplies probe.json and seed files. They differ because one probe (e.g.
 * write-then-read) can back a more specific case name.
 */
function probeCase(id, checks, { probe = id, ...extra } = {}) {
  return {
    id,
    // Each case owns a workspace directory so a file written by one case can
    // never be seen by the next; --workspace points at the parent.
    workspace: `workspaces/${probe}`,
    argv: [NODE, SERVER, '.'],
    timeout_s: 45,
    driver: { argv: [NODE, 'probe.mjs'] },
    checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }, ...checks],
    ...extra,
  };
}

/** Assert the probe step succeeded (no MCP error). */
const ok = (id) => ({ id: `${id}-ok`, kind: 'json_equals', path: 'outputs/probe-result.json', key: `${id}.is_error`, equals: false });
/** Assert the probe step was rejected by the server. */
const rejected = (id) => ({ id: `${id}-rejected`, kind: 'json_equals', path: 'outputs/probe-result.json', key: `${id}.is_error`, equals: true });
/** Assert a substring appears in the step's returned text. */
const has = (id, value) => ({
  id: `${id}-text`,
  kind: 'script',
  path: 'contains.py',
  interpreter: ['py', '-3'],
  args: ['outputs/probe-result.json', id, value],
  pass_exit_codes: [0],
});

const cases = [
  // --- protocol surface -----------------------------------------------------
  probeCase('protocol-initializes', [
    { id: 'handshake', kind: 'json_equals', path: 'outputs/probe-result.json', key: '__init.ok', equals: true },
    { id: 'server-name', kind: 'json_equals', path: 'outputs/probe-result.json', key: '__init.name', equals: 'secure-filesystem-server' },
  ]),
  probeCase('tools-listed', [
    // The full 14-tool surface must be present; a missing tool is a contract break.
    { id: 'has-read', kind: 'script', path: 'check-tools.py', interpreter: ['py', '-3'], pass_exit_codes: [0] },
  ]),

  // --- happy paths ----------------------------------------------------------
  probeCase('write-file-succeeds', [ok('write'), has('write', 'Successfully wrote')], { probe: 'write-then-read' }),
  probeCase('create-directory-succeeds', [ok('mkdir')], { probe: 'create-directory' }),
  probeCase('list-directory-succeeds', [ok('list'), has('list', 'one.txt')], { probe: 'list-directory' }),
  probeCase('list-with-sizes-succeeds', [ok('sizes'), has('sizes', 'two.txt')], { probe: 'list-with-sizes' }),
  probeCase('directory-tree-succeeds', [ok('tree'), has('tree', 'inner.txt')], { probe: 'directory-tree' }),
  probeCase('get-file-info-succeeds', [ok('info'), has('info', 'isFile: true')], { probe: 'get-file-info' }),
  probeCase('allowed-directories-succeeds', [ok('roots')], { probe: 'allowed-directories' }),
  probeCase('move-file-succeeds', [ok('move')], { probe: 'move-file' }),
  probeCase('edit-file-succeeds', [ok('edit'), has('edit', 'BBB')], { probe: 'edit-file' }),
  probeCase('search-files-succeeds', [ok('search'), has('search', 'hit.txt')], { probe: 'search-files' }),
  probeCase('read-multiple-succeeds', [ok('multi'), has('multi', 'first')], { probe: 'read-multiple' }),
  probeCase('read-head-truncates', [ok('head'), has('head', 'line1')], { probe: 'read-file-head' }),

  // --- error handling: the server must reject, not crash ---------------------
  probeCase('read-missing-file-rejected', [rejected('read')], { probe: 'read-missing-file' }),
  probeCase('list-missing-dir-rejected', [rejected('list')], { probe: 'list-missing-dir' }),
  probeCase('move-missing-source-rejected', [rejected('move')], { probe: 'move-missing-source' }),
  probeCase('edit-no-match-rejected', [rejected('edit')], { probe: 'edit-no-match' }),
  probeCase('search-no-match-empty', [ok('search')], { probe: 'search-no-match' }),
  probeCase('read-media-missing-rejected', [rejected('media')], { probe: 'read-media-file' }),

  // --- security: path confinement is the whole point of this server ---------
  probeCase('rejects-dotdot-traversal', [rejected('traversal')], { probe: 'path-traversal-dotdot' }),
  probeCase('rejects-absolute-outside-root', [rejected('abs')], { probe: 'path-traversal-abs' }),
  probeCase('rejects-write-outside-root', [rejected('escape')], { probe: 'write-outside-root' }),
  probeCase('rejects-mkdir-outside-root', [rejected('evil')], { probe: 'create-dir-traversal' }),
];

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'mcp-filesystem-full',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  cases,
};

writeFileSync('suite.json', JSON.stringify(suite, null, 2) + '\n');
console.log(`wrote suite.json with ${cases.length} cases`);
