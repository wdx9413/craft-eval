// Regenerate every probe.json as a JSON array.
//
// PowerShell's ConvertTo-Json collapses a one-element array into a bare object,
// which silently broke the driver (steps is not iterable). The probes are
// therefore defined here, in JS, and written as arrays — one source of truth.
import { mkdirSync, writeFileSync } from 'node:fs';

const probes = {
  'protocol-initializes': [],
  'tools-listed': [],
  'write-then-read': [{ id: 'write', tool: 'write_file', arguments: { path: 'a.txt', content: 'hello-craft' } }],
  'create-directory': [{ id: 'mkdir', tool: 'create_directory', arguments: { path: 'nested/deep/dir' } }],
  'list-directory': [{ id: 'list', tool: 'list_directory', arguments: { path: '.' } }],
  'list-with-sizes': [{ id: 'sizes', tool: 'list_directory_with_sizes', arguments: { path: '.' } }],
  'directory-tree': [{ id: 'tree', tool: 'directory_tree', arguments: { path: '.' } }],
  'get-file-info': [{ id: 'info', tool: 'get_file_info', arguments: { path: 'target.txt' } }],
  'allowed-directories': [{ id: 'roots', tool: 'list_allowed_directories', arguments: {} }],
  'move-file': [{ id: 'move', tool: 'move_file', arguments: { source: 'mv-src.txt', destination: 'mv-dst.txt' } }],
  'edit-file': [{ id: 'edit', tool: 'edit_file', arguments: { path: 'edit.txt', edits: [{ oldText: 'AAA', newText: 'BBB' }] } }],
  'search-files': [{ id: 'search', tool: 'search_files', arguments: { path: '.', pattern: '*.txt' } }],
  'read-multiple': [{ id: 'multi', tool: 'read_multiple_files', arguments: { paths: ['m1.txt', 'm2.txt'] } }],
  'read-file-head': [{ id: 'head', tool: 'read_text_file', arguments: { path: 'long.txt', head: 2 } }],
  'read-missing-file': [{ id: 'read', tool: 'read_text_file', arguments: { path: 'does-not-exist.txt' } }],
  'list-missing-dir': [{ id: 'list', tool: 'list_directory', arguments: { path: 'no-such-dir' } }],
  'move-missing-source': [{ id: 'move', tool: 'move_file', arguments: { source: 'ghost.txt', destination: 'x.txt' } }],
  'edit-no-match': [{ id: 'edit', tool: 'edit_file', arguments: { path: 'nomatch.txt', edits: [{ oldText: 'ZZZ', newText: 'YYY' }] } }],
  'search-no-match': [{ id: 'search', tool: 'search_files', arguments: { path: '.', pattern: '*.nomatch' } }],
  'read-media-file': [{ id: 'media', tool: 'read_media_file', arguments: { path: 'pic.png' } }],
  'path-traversal-dotdot': [{ id: 'traversal', tool: 'read_text_file', arguments: { path: '../../../../etc/passwd' } }],
  'path-traversal-abs': [{ id: 'abs', tool: 'read_text_file', arguments: { path: 'C:\\Windows\\win.ini' } }],
  'write-outside-root': [{ id: 'escape', tool: 'write_file', arguments: { path: '../escaped.txt', content: 'nope' } }],
  'create-dir-traversal': [{ id: 'evil', tool: 'create_directory', arguments: { path: '../evil-dir' } }],
};

for (const [name, steps] of Object.entries(probes)) {
  mkdirSync(`probes/${name}`, { recursive: true });
  writeFileSync(`probes/${name}/probe.json`, JSON.stringify(steps, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(probes).length} probe files`);
