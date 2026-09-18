import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { sessionToolToModelOutput } from '../src/agent/vnext/sessionWorkspace/canvasPreview.js';
import { attachToolFailureHint } from '../src/agent/vnext/sessionWorkspace/toolReceipt.js';

const SCHEMA_LIMITS = {
  action: 700,
  run: 600
};

const FORBIDDEN_IN_DESCRIPTION = [
  /Failure codes include/i,
  /\bTAB_LEASED\b/,
  /\bNEED_PAGE\b/,
  /\bFILE_CHOOSER\b/,
  /\bRAW_ESCAPE_DENIED\b/,
  /\bNO_TARGET\b/
];

function sessionTools() {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const fs = createSessionGuestFs(store, { sessionId: 's', executionId: 'e' });
  return createSessionTools({ store, execution: { executionId: 'e' }, fs, sessionId: 's' });
}

test('action and run descriptions stay short contracts', () => {
  const tools = sessionTools();
  for (const [name, limit] of Object.entries(SCHEMA_LIMITS)) {
    const text = String(tools[name]?.description || '');
    assert.ok(text.length, `${name} has a description`);
    assert.ok(text.length <= limit, `${name} description ${text.length} > ${limit}`);
    for (const re of FORBIDDEN_IN_DESCRIPTION) {
      assert.doesNotMatch(text, re, `${name} description matches ${re}`);
    }
  }
  assert.match(tools.run.description, /sys\.eval/);
  assert.match(tools.action.description, /sys\.eval/);
  const codeDesc = String(tools.run.parameters.properties.code.description || '');
  assert.ok(codeDesc.length <= 200, `run.code.description ${codeDesc.length} > 200`);
  assert.match(codeDesc, /inspect view=sys/);
  assert.doesNotMatch(codeDesc, /sys\.tabs\.list/);
});

test('NO_TARGET and RAW_ESCAPE_DENIED hints point at sys.eval', () => {
  const noTarget = attachToolFailureHint({ ok: false, code: 'NO_TARGET', error: 'no matching control' });
  assert.match(noTarget.hint, /sys\.eval/);
  assert.match(noTarget.hint, /MAIN/);
  const raw = attachToolFailureHint({ ok: false, code: 'RAW_ESCAPE_DENIED', error: 'Guarded blocks raw' });
  assert.match(raw.hint, /Full Access/);
  assert.match(raw.hint, /sys\.eval/);
  const model = sessionToolToModelOutput({
    output: { ok: false, code: 'NO_TARGET', error: 'no matching control' }
  });
  assert.equal(model.type, 'json');
  assert.match(String(model.value.hint), /sys\.eval/);
});
