import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachToolFailureHint } from '../src/agent/vnext/sessionWorkspace/toolReceipt.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('page scripts and tab capture are optional; debugger stays required because Chrome forbids making it optional', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.deepEqual(m.optional_permissions.sort(), ['tabCapture', 'userScripts']);
  for (const p of ['userScripts', 'tabCapture']) assert.equal(m.permissions.includes(p), false, p);
  assert.ok(m.permissions.includes('debugger'));
  assert.ok(m.permissions.includes('identity'));
});

test('missing optional permissions surface as PERMISSION_REQUIRED with a hint the model can relay', () => {
  assert.match(read('src/agent/vnext/host/browserSysHost.js'), /code: 'PERMISSION_REQUIRED',\s*permission: 'userScripts'/);
  assert.match(read('src/agent/vnext/host/tabListen.js'), /code: 'PERMISSION_REQUIRED', permission: 'tabCapture'/);
  const hinted = attachToolFailureHint({ ok: false, code: 'PERMISSION_REQUIRED', permission: 'userScripts', error: 'off' });
  assert.match(hinted.hint, /Advanced abilities/);
});

test('permission requests run first inside the click, before anything awaits', () => {
  const panel = read('src/sidepanel.js');
  const grant = panel.slice(panel.indexOf('async function confirmListenGrant()'));
  const firstAwait = grant.indexOf('await ');
  assert.ok(grant.slice(firstAwait, firstAwait + 80).includes("chrome.permissions.request({ permissions: ['tabCapture'] })"));
  const enable = panel.slice(panel.indexOf('function enablePageScripts()'), panel.indexOf('async function refreshVendorBoards()'));
  assert.doesNotMatch(enable, /await /);
  assert.match(enable, /return requestPageScripts\(\)/);
  // The shared helper asks straight away, and the welcome tab calls it first in its click.
  const shared = read('src/sidepanel/pageScripts.js');
  const req = shared.slice(shared.indexOf('export function requestPageScripts()'));
  assert.match(req.slice(0, 160), /return chrome\.permissions\.request\(\{ permissions: \['userScripts'\] \}\)/);
  const welcome = read('src/welcome/welcome.js');
  const click = welcome.slice(welcome.indexOf("$('scriptsBtn').addEventListener"));
  assert.match(click.slice(0, 200), /requestPageScripts\(\)\.then/);
  const open = welcome.slice(welcome.indexOf("$('openPanelBtn').addEventListener"));
  assert.doesNotMatch(open.slice(0, open.indexOf('});')), /await /);
});
