import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, decideAccess, deriveRawEscape } from '../src/agent/vnext/host/riskClassify.js';
import {
  clearVisualReplay,
  coarseSampleHash,
  cssViewportPoint,
  jpegPixelSize,
  settleVisualPointer,
  viewportAspectMismatch,
  visualFallbackCause,
  visualReplayBlocked,
  withVisualFallback
} from '../src/agent/vnext/host/visualClick.js';

function sofJpeg(width, height) {
  const bytes = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 255, height & 255,
    (width >> 8) & 255, width & 255,
    0x03,
    0xff, 0xd9
  ]);
  return Buffer.from(bytes).toString('base64');
}

test('DOM misses become FALLBACK_VISUAL and policy refusals do not', () => {
  const missed = withVisualFallback({ ok: false, code: 'NO_TARGET', error: 'no control' }, 'click');
  assert.equal(missed.code, 'FALLBACK_VISUAL');
  assert.equal(missed.cause, 'NO_TARGET');
  assert.match(missed.hint, /method=cdp/);

  const stale = withVisualFallback({ ok: false, code: 'STALE_REF', refreshed: true }, 'fill');
  assert.equal(stale.code, 'FALLBACK_VISUAL');
  assert.equal(stale.cause, 'STALE_REF');

  const canvas = withVisualFallback({ ok: false, code: 'NO_TARGET', hit: 'canvas' }, 'click');
  assert.equal(canvas.code, 'FALLBACK_VISUAL');

  const frame = withVisualFallback({ ok: false, code: 'NEED_PAGE', frameUnreachable: true }, 'fill_form');
  assert.equal(frame.cause, 'frame');

  assert.equal(visualFallbackCause({ ok: false, code: 'STALE_REF' }, 'click'), '');
  for (const code of ['PAYMENT_DENIED', 'TAB_LEASED', 'BAD_INPUT']) {
    const kept = withVisualFallback({ ok: false, code }, 'click');
    assert.equal(kept.code, code);
  }
  assert.equal(withVisualFallback({ ok: false, code: 'NO_TARGET' }, 'scroll').code, 'NO_TARGET');
});

test('pointer coordinates use CSS viewport pixels and ignore devicePixelRatio', () => {
  const viewport = { clientWidth: 800, clientHeight: 600, devicePixelRatio: 2 };
  const point = cssViewportPoint(0.5, 0.25, viewport);
  assert.deepEqual(point, { x: 400, y: 150 });
  assert.notEqual(point.x, 0.5 * viewport.clientWidth * viewport.devicePixelRatio);
  assert.equal(cssViewportPoint(0.5, 0.5, { clientWidth: 0, clientHeight: 600 }), null);
});

test('screenshot aspect follows CSS viewport, so device pixels do not count as a mismatch', () => {
  const size = jpegPixelSize(sofJpeg(1600, 1200));
  assert.deepEqual(size, { width: 1600, height: 1200 });
  assert.equal(viewportAspectMismatch(size.width, size.height, 800, 600), false);
  assert.equal(viewportAspectMismatch(size.width, size.height, 800, 200), true);
});

test('an unchanged pointer is not replayed for the same execution and point', () => {
  const executionId = 'exec-visual';
  clearVisualReplay(executionId);
  const scene = { url: 'https://example.com/app', documentId: 'doc-1', hash: 'ab' };
  const first = settleVisualPointer({ executionId, x: 0.5, y: 0.25, before: scene, after: scene });
  assert.equal(first.code, 'VISUAL_UNCHANGED');
  assert.equal(first.replayed, false);
  assert.equal(visualReplayBlocked(executionId, 0.5, 0.25), true);
  const second = settleVisualPointer({ executionId, x: 0.5, y: 0.25, before: scene, after: scene });
  assert.equal(second.replayed, true);
  const moved = settleVisualPointer({
    executionId,
    x: 0.5,
    y: 0.25,
    before: scene,
    after: { ...scene, documentId: 'doc-2' }
  });
  assert.equal(moved.code, 'VISUAL_UNCHANGED');
  assert.equal(moved.replayed, true);
  const other = settleVisualPointer({
    executionId,
    x: 0.2,
    y: 0.2,
    before: scene,
    after: { ...scene, url: 'https://example.com/next' }
  });
  assert.equal(other.code, 'changed');
  clearVisualReplay(executionId);
  assert.equal(visualReplayBlocked(executionId, 0.5, 0.25), false);
});

test('coarse hashes match identical samples and a left-click CDP pointer is not raw', () => {
  const samples = new Uint8Array(8 * 8 * 4).fill(40);
  assert.equal(coarseSampleHash(samples), coarseSampleHash(samples));
  samples[0] = 200;
  assert.notEqual(coarseSampleHash(samples), coarseSampleHash(new Uint8Array(8 * 8 * 4).fill(40)));

  const pointer = classifyRisk({ channel: 'action', op: 'pointer', method: 'cdp' });
  assert.equal(pointer.risk, 'external-commit');
  assert.equal(pointer.confidence, 'unknown');
  assert.equal(decideAccess('guarded', pointer), 'approve');
  assert.equal(decideAccess('full', pointer), 'auto');
  assert.equal(deriveRawEscape('guarded', pointer.risk), 'n/a');

  const raw = classifyRisk({ channel: 'sys', op: 'cdp', method: 'Input.dispatchMouseEvent' });
  assert.equal(raw.risk, 'raw-escape');
  assert.equal(decideAccess('guarded', raw), 'deny');
});
