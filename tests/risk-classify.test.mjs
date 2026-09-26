import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRisk,
  decideAccess,
  rawEscapeFor,
  needsDispatchTicket,
  mergeBatchClassification,
  CLASSIFIED_SOURCE_SW
} from '../src/agent/vnext/host/riskClassify.js';

test('host classifier ignores model risk/intent and treats named Save as known reversible', () => {
  const out = classifyRisk({
    channel: 'action',
    op: 'click',
    name: 'Save',
    risk: 'read',
    intent: 'harmless',
    confidence: 'known',
    safe: true
  });
  assert.equal(out.risk, 'reversible-write');
  assert.equal(out.confidence, 'known');
  assert.equal(decideAccess(out), 'auto');
  assert.equal(needsDispatchTicket(out), true);
});

test('known payment and delete stay known even when the model claims read', () => {
  const pay = classifyRisk({ channel: 'action', op: 'click', name: 'Pay now', risk: 'read' });
  assert.equal(pay.risk, 'payment');
  assert.equal(pay.confidence, 'known');
  assert.equal(decideAccess(pay), 'deny');

  const del = classifyRisk({ channel: 'action', op: 'click', name: 'Delete permanently', risk: 'read' });
  assert.equal(del.risk, 'delete');
  assert.equal(del.confidence, 'known');
  assert.equal(decideAccess(del), 'approve');
});

test('cart and checkout landing are not payment; checkout submit is', () => {
  const cart = classifyRisk({ channel: 'action', op: 'click', name: 'Add to cart' });
  assert.equal(cart.risk, 'external-commit');
  assert.notEqual(cart.risk, 'payment');
  const openCheckout = classifyRisk({ channel: 'sys', op: 'tabs.navigate', url: 'https://shop.example/checkout' });
  assert.equal(openCheckout.risk, 'read');
  const submit = classifyRisk({
    channel: 'action',
    op: 'click',
    name: 'Submit',
    control: { type: 'submit', name: 'Submit' },
    url: 'https://shop.example/checkout/pay'
  });
  assert.equal(submit.risk, 'payment');
  assert.equal(submit.confidence, 'known');
});

test('unknown and raw run automatically; payment/delete stay hard', () => {
  const unknown = classifyRisk({ channel: 'action', op: 'click' });
  assert.equal(unknown.confidence, 'unknown');
  assert.equal(decideAccess(unknown), 'auto');

  const raw = classifyRisk({ channel: 'sys', op: 'eval', code: 'return 1' });
  assert.equal(raw.risk, 'raw-escape');
  assert.equal(decideAccess(raw), 'auto');
  assert.equal(rawEscapeFor('raw-escape'), 'allow');
  assert.equal(rawEscapeFor('read'), 'n/a');

  const cdp = classifyRisk({ channel: 'sys', op: 'cdp', action: 'attach' });
  assert.equal(cdp.risk, 'raw-escape');
  const cdpRead = classifyRisk({ channel: 'sys', op: 'cdp', method: 'DOM.getDocument' });
  assert.equal(cdpRead.risk, 'read');
});

test('fetch GET is read; POST to a delete path is known delete', () => {
  const get = classifyRisk({ channel: 'sys', op: 'fetch', method: 'GET', url: 'https://example.com' });
  assert.equal(get.risk, 'read');
  assert.equal(needsDispatchTicket(get), false);
  const del = classifyRisk({ channel: 'sys', op: 'fetch', method: 'POST', url: 'https://example.com/api/delete' });
  assert.equal(del.risk, 'delete');
  assert.equal(del.confidence, 'known');
});

test('Stripe iframe Submit is known payment; shop URL cannot override frameUrl; undelete is not delete', () => {
  const iframe = classifyRisk({
    channel: 'action',
    op: 'click',
    name: 'Submit',
    url: 'https://shop.example/cart',
    control: { name: 'Submit', frameUrl: 'https://js.stripe.com/v3/controller', role: 'button' }
  });
  assert.equal(iframe.risk, 'payment');
  assert.equal(iframe.confidence, 'known');
  assert.equal(iframe.target.url, 'https://js.stripe.com/v3/controller');
  assert.equal(decideAccess(iframe), 'deny');

  const shopOnly = classifyRisk({
    channel: 'action',
    op: 'click',
    name: 'Submit',
    url: 'https://shop.example/cart',
    control: { name: 'Submit', frameUrl: 'https://shop.example/cart' }
  });
  assert.notEqual(shopOnly.risk, 'payment');

  const undelete = classifyRisk({ channel: 'action', op: 'click', name: 'Undelete item' });
  assert.notEqual(undelete.risk, 'delete');
  const realDelete = classifyRisk({ channel: 'action', op: 'click', name: 'Delete item' });
  assert.equal(realDelete.risk, 'delete');
});

test('batch fill_form takes the highest frame risk, not the first field', () => {
  const shop = classifyRisk({
    channel: 'action',
    op: 'fill_form',
    name: 'Email',
    control: { name: 'Email', frameUrl: 'https://shop.example/cart' }
  });
  const stripe = classifyRisk({
    channel: 'action',
    op: 'fill_form',
    name: 'Card number',
    control: { name: 'Card number', frameUrl: 'https://js.stripe.com/v3/controller' }
  });
  assert.equal(shop.risk, 'reversible-write');
  assert.equal(stripe.risk, 'payment');
  const merged = mergeBatchClassification([shop, stripe], [
    { frameId: 0, frameUrl: 'https://shop.example/cart', documentId: 'doc-shop', classified: shop, control: { name: 'Email' } },
    { frameId: 1, frameUrl: 'https://js.stripe.com/v3/controller', documentId: 'doc-stripe', classified: stripe, control: { name: 'Card number' } }
  ]);
  assert.equal(merged.risk, 'payment');
  assert.equal(merged.confidence, 'known');
  assert.equal(merged.source, CLASSIFIED_SOURCE_SW);
  assert.equal(merged.target.frames.length, 2);
  const reverse = mergeBatchClassification([stripe, shop], [
    { frameId: 1, classified: stripe, control: { frameUrl: 'https://js.stripe.com/v3/controller' } },
    { frameId: 0, classified: shop, control: { frameUrl: 'https://shop.example/cart' } }
  ]);
  assert.equal(reverse.risk, 'payment');
});
