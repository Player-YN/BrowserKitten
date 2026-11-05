import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'paw-pack-'));
  cpSync(resolve('scripts'), join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'icons'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.2.0', background: { service_worker: 'src/background.js' } }));
  writeFileSync(join(root, 'LICENSE'), 'test');
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'Third-party license notices');
  writeFileSync(join(root, 'src/background.js'), "import './untracked.js';\n");
  writeFileSync(join(root, 'src/untracked.js'), 'export const value = 1;\n');
  return root;
}
const runPack = root => execFileSync('python3', ['scripts/pack_extension.py'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
test('no-git working-tree package includes new runtime modules and excludes hidden credentials', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'src/.secret.js'), 'private');
    writeFileSync(join(root, 'src/credentials.json'), '{"secret":1}');
    writeFileSync(join(root, 'src/AGENTS.md'), '# private development note');
    runPack(root);
    assert.equal(readFileSync(join(root, 'extension/THIRD_PARTY_NOTICES.md'), 'utf8'), 'Third-party license notices');
    assert.equal(readFileSync(join(root, 'extension/src/untracked.js'), 'utf8'), 'export const value = 1;\n');
    for (const file of ['.secret.js', 'credentials.json', 'AGENTS.md']) assert.equal(existsSync(join(root, 'extension/src', file)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('package refuses a missing literal import instead of shipping an incomplete extension', () => {
  const root = fixture();
  try {
    rmSync(join(root, 'src/untracked.js'));
    assert.throws(() => runPack(root), error => String(error.stderr).includes('missing src/untracked.js'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('source parity detects stale packed modules after source changes', () => {
  const root = fixture();
  try {
    runPack(root); writeFileSync(join(root, 'src/untracked.js'), 'export const value = 2;\n');
    assert.throws(() => execFileSync('python3', ['scripts/verify_extension.py', 'extension', '--source', '.'], { cwd: root, stdio: 'pipe' }),
      error => String(error.stderr).includes('different bytes in src/untracked.js'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
