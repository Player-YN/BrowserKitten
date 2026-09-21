import { validatePersonalLibraryInput } from '../agent/vnext/service/personalLibraryContract.js';

/** One parameter flow for published tools, workflows, shortcuts and drafts. */
export async function collectPersonalLibraryInput(entry, { document: doc = document, t = x => x } = {}) {
  const schema = entry.parameters || {};
  if (!Object.keys(schema.properties || {}).length) return validatePersonalLibraryInput(schema, {});
  return new Promise(resolve => {
    const dialog = doc.createElement('dialog'); dialog.className = 'personal-library-dialog library-parameter-dialog';
    const form = doc.createElement('form');
    const title = doc.createElement('h3'); title.textContent = entry.name || t('libraryParameters'); form.appendChild(title);
    const fields = new Map();
    for (const [key, spec] of Object.entries(schema.properties || {})) {
      const label = doc.createElement('label');
      const text = doc.createElement('span'); text.textContent = spec.title || key; label.appendChild(text);
      const input = doc.createElement(spec.enum ? 'select' : 'input');
      input.name = key;
      if (spec.enum) {
        const blank = doc.createElement('option'); blank.value = ''; blank.textContent = '—'; input.appendChild(blank);
        spec.enum.forEach((value, index) => { const option = doc.createElement('option'); option.value = String(index); option.textContent = String(value); input.appendChild(option); });
        if (spec.default !== undefined) input.value = String(spec.enum.indexOf(spec.default));
      } else {
        input.type = spec.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(spec.type) ? 'number' : 'text';
        if (input.type === 'number') input.step = spec.type === 'integer' ? '1' : 'any';
        if (spec.type === 'boolean') input.checked = spec.default === true;
        else if (spec.default !== undefined) input.value = String(spec.default);
      }
      input.setAttribute('aria-label', spec.title || key);
      input.title = spec.description || '';
      // A required boolean may legitimately be false.
      input.required = (schema.required || []).includes(key) && input.type !== 'checkbox';
      label.appendChild(input); form.appendChild(label); fields.set(key, input);
    }
    const error = doc.createElement('output'); error.setAttribute('role', 'alert'); form.appendChild(error);
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = t('libraryCancel');
    const submit = doc.createElement('button'); submit.type = 'submit'; submit.textContent = t('libraryRun');
    let settled = false;
    const finish = value => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        if (form.reportValidity && !form.reportValidity()) return;
        const input = {};
        for (const [key, spec] of Object.entries(schema.properties || {})) {
          const field = fields.get(key);
          if (spec.enum) { if (field.value !== '') input[key] = spec.enum[Number(field.value)]; }
          else if (spec.type === 'boolean') input[key] = field.checked;
          else if (field.value !== '') input[key] = ['number', 'integer'].includes(spec.type) ? Number(field.value) : field.value;
        }
        finish(validatePersonalLibraryInput(schema, input));
      } catch (e) { error.textContent = e.message; }
    });
    form.appendChild(cancel); form.appendChild(submit); dialog.appendChild(form); doc.body.appendChild(dialog); dialog.showModal();
  });
}

/** Rendering only. Persistence, conversations and execution are supplied by the caller. */
export function createPersonalLibraryUi(opts = {}) {
  const doc = opts.document || document;
  const $ = opts.$ || (id => doc.getElementById(id));
  const t = opts.t || (x => x);
  let kind = 'tool'; let entries = []; let pins = []; let refreshSequence = 0;
  const dialog = $('personalLibraryDialog'); const list = $('personalLibraryList');
  const report = error => opts.onError?.(error);
  const invoke = fn => Promise.resolve().then(fn).catch(report);
  const button = (parent, label, fn) => {
    const element = doc.createElement('button'); element.type = 'button'; element.textContent = label;
    element.addEventListener('click', () => invoke(async () => {
      if (element.disabled) return;
      element.disabled = true;
      try { await fn(); } finally { element.disabled = false; }
    }));
    parent.appendChild(element); return element;
  };
  async function run(entry) {
    close(); // Host approval UI must remain reachable during script execution.
    const input = await collectPersonalLibraryInput(entry, { document: doc, t });
    if (input !== null) await opts.run?.(entry, input);
  }
  function renderSlots() {
    ['personalToolsBtn', 'personalWorkflowsBtn'].forEach((id, index) => {
      const node = $(id); if (!node) return;
      const entry = entries.find(row => row.entryId === pins[index]);
      node.textContent = entry?.name || (index === 0 ? t('libraryTools') : 'Workflow');
      node.title = entry ? `${t(entry.kind === 'tool' ? 'libraryRun' : 'libraryStart')} · ${entry.name}` : t('libraryTitle');
      node.setAttribute('aria-label', node.title);
      node.onclick = () => invoke(() => entry ? run(entry) : open(index === 0 ? 'tool' : 'workflow'));
    });
  }
  function render() {
    renderSlots();
    if (!list) return;
    list.replaceChildren();
    const rows = entries.filter(entry => entry.kind === kind);
    if (!rows.length) { const empty = doc.createElement('p'); empty.className = 'personal-library-empty'; empty.textContent = t('libraryEmpty'); list.appendChild(empty); }
    for (const entry of rows) {
      const card = doc.createElement('article'); card.className = 'personal-library-card';
      const name = doc.createElement('strong');
      const type = entry.kind === 'workflow' ? (entry.workflow?.version === 1 ? (opts.workflowLabel?.() || 'Automation') : (opts.agentTaskLabel?.() || 'Agent task')) : '';
      name.textContent = `${entry.name} · v${entry.revision}${type ? ` · ${type}` : ''}`; card.appendChild(name);
      const detail = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = t('libraryView');
      const code = doc.createElement('pre'); code.textContent = entry.code || entry.instructions || (entry.workflow ? JSON.stringify(entry.workflow, null, 2) : '');
      detail.appendChild(summary); detail.appendChild(code); card.appendChild(detail);
      const actions = doc.createElement('div'); actions.className = 'personal-library-card-actions';
      button(actions, t(entry.kind === 'tool' ? 'libraryRun' : 'libraryStart'), () => run(entry));
      button(actions, t('libraryEdit'), () => opts.create?.(entry.kind, entry));
      button(actions, t(pins.includes(entry.entryId) ? 'libraryUnpin' : 'libraryPin'), async () => {
        const next = pins.includes(entry.entryId) ? pins.filter(id => id !== entry.entryId) : [...pins, entry.entryId].slice(-2);
        await opts.setPins?.(next); pins = next; render();
      });
      button(actions, t('libraryRevert'), () => opts.revert?.(entry));
      button(actions, t('libraryDelete'), () => opts.remove?.(entry));
      card.appendChild(actions); list.appendChild(card);
    }
    dialog?.querySelectorAll('[data-library-kind]').forEach(node => node.setAttribute('aria-selected', String(node.dataset.libraryKind === kind)));
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    const [result, savedPins] = await Promise.all([opts.rpc('listPersonalLibrary', {}), opts.getPins?.()]);
    if (sequence !== refreshSequence) return;
    entries = Array.isArray(result) ? result : result?.entries || [];
    pins = [...new Set(Array.isArray(savedPins) ? savedPins : [])].filter(id => entries.some(entry => entry.entryId === id)).slice(0, 2);
    render();
  }
  async function open(next = kind) { kind = next; if (!dialog?.open) dialog?.showModal(); await refresh(); }
  function close() { dialog?.close(); }
  function wire() {
    $('personalLibraryManageBtn')?.addEventListener('click', () => invoke(() => open()));
    $('personalLibraryClose')?.addEventListener('click', close);
    dialog?.querySelectorAll('[data-library-kind]').forEach(node => node.addEventListener('click', () => invoke(() => open(node.dataset.libraryKind))));
    $('personalLibraryCreate')?.addEventListener('click', () => invoke(async () => { close(); await opts.create?.(kind); }));
    $('personalLibraryExport')?.addEventListener('click', () => invoke(() => opts.export?.()));
    $('personalLibraryImport')?.addEventListener('click', () => $('personalLibraryImportFile')?.click());
    $('personalLibraryImportFile')?.addEventListener('change', event => invoke(async () => {
      try { await opts.import?.(event.target.files?.[0]); } finally { event.target.value = ''; }
    }));
    renderSlots();
    return invoke(refresh);
  }
  return { wire, open, close, refresh, render, run };
}
