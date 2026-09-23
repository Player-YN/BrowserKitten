/**
 * Compact searchable preset combobox for the settings editors.
 * Closed control stays one row; the list overlays and does not push layout.
 */

/**
 * @typedef {{ id: string, name: string, baseURL?: string }} PresetComboboxItem
 */

/**
 * @param {{
 *   root: HTMLElement,
 *   items: PresetComboboxItem[],
 *   placeholder?: string,
 *   emptyText?: string,
 *   onSelect?: (id: string) => void,
 *   getItemLabel?: (item: PresetComboboxItem) => string
 * }} opts
 */
export function mountPresetCombobox(opts) {
  const root = opts.root;
  const input = root.querySelector('.preset-combobox-input');
  const list = root.querySelector('.preset-combobox-list');
  if (!(input instanceof HTMLInputElement) || !(list instanceof HTMLElement)) {
    throw new Error('preset combobox missing input/list');
  }

  /** @type {PresetComboboxItem[]} */
  let items = Array.isArray(opts.items) ? opts.items.slice() : [];
  let valueId = '';
  let filter = '';
  let open = false;
  let activeIndex = -1;
  let suppressBlurClose = false;

  const placeholder = () => opts.placeholder || '选择模板';
  const emptyText = () => opts.emptyText || '无匹配模板';
  const labelOf = (item) =>
    (opts.getItemLabel ? opts.getItemLabel(item) : item?.name) || item?.id || '';

  function findItem(id) {
    return items.find((it) => it.id === id) || null;
  }

  function filteredItems() {
    const q = filter.trim().toLowerCase();
    if (!q) return items.slice();
    return items.filter((it) => {
      const name = String(it.name || '').toLowerCase();
      const base = String(it.baseURL || '').toLowerCase();
      const id = String(it.id || '').toLowerCase();
      return name.includes(q) || base.includes(q) || id.includes(q);
    });
  }

  function syncClosedDisplay() {
    const item = findItem(valueId);
    input.value = item ? labelOf(item) : '';
    input.placeholder = placeholder();
  }

  function setAriaExpanded(next) {
    input.setAttribute('aria-expanded', next ? 'true' : 'false');
  }

  function close() {
    if (!open) return;
    open = false;
    filter = '';
    activeIndex = -1;
    list.hidden = true;
    list.innerHTML = '';
    setAriaExpanded(false);
    syncClosedDisplay();
  }

  function paintList() {
    const rows = filteredItems();
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'preset-combobox-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = emptyText();
      list.appendChild(empty);
      activeIndex = -1;
      return;
    }
    if (activeIndex < 0 || activeIndex >= rows.length) activeIndex = 0;
    rows.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'preset-combobox-option';
      li.setAttribute('role', 'option');
      li.id = `${list.id || 'preset-opt'}-${item.id}`;
      li.dataset.id = item.id;
      li.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
      if (idx === activeIndex) li.classList.add('is-active');
      if (item.id === valueId) li.classList.add('is-on');

      const title = document.createElement('span');
      title.className = 'preset-combobox-option-name';
      title.textContent = labelOf(item);
      li.appendChild(title);

      const base = String(item.baseURL || '').trim();
      if (base) {
        const sub = document.createElement('span');
        sub.className = 'preset-combobox-option-base';
        sub.textContent = base;
        li.appendChild(sub);
      }

      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        suppressBlurClose = true;
        pick(item.id);
      });
      list.appendChild(li);
    });
    const active = list.querySelector('.preset-combobox-option.is-active');
    if (active instanceof HTMLElement) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function openList(optsOpen = {}) {
    open = true;
    setAriaExpanded(true);
    list.hidden = false;
    if (optsOpen.clearFilter) {
      filter = '';
      input.value = '';
    }
    paintList();
  }

  function pick(id) {
    const item = findItem(id);
    if (!item) return;
    valueId = id;
    close();
    opts.onSelect?.(id);
  }

  function moveActive(delta) {
    const rows = filteredItems();
    if (!rows.length) return;
    if (!open) openList();
    activeIndex = (activeIndex + delta + rows.length) % rows.length;
    paintList();
  }

  input.addEventListener('focus', () => {
    filter = '';
    openList({ clearFilter: true });
  });

  input.addEventListener('input', () => {
    filter = input.value;
    if (!open) openList();
    else paintList();
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveActive(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveActive(-1);
    } else if (ev.key === 'Enter') {
      if (!open) return;
      ev.preventDefault();
      const rows = filteredItems();
      const hit = rows[activeIndex] || rows[0];
      if (hit) pick(hit.id);
    } else if (ev.key === 'Escape') {
      if (!open) return;
      ev.preventDefault();
      close();
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    if (suppressBlurClose) {
      suppressBlurClose = false;
      return;
    }
    // Defer so mousedown on option can run first.
    setTimeout(() => {
      if (suppressBlurClose) {
        suppressBlurClose = false;
        return;
      }
      close();
    }, 0);
  });

  function onDocPointer(ev) {
    if (!open) return;
    const t = ev.target;
    if (t instanceof Node && root.contains(t)) return;
    close();
  }
  document.addEventListener('pointerdown', onDocPointer, true);

  syncClosedDisplay();

  return {
    /** @param {PresetComboboxItem[]} next */
    setItems(next) {
      items = Array.isArray(next) ? next.slice() : [];
      if (valueId && !findItem(valueId)) valueId = '';
      if (open) paintList();
      else syncClosedDisplay();
    },
    /** @param {string|null|undefined} id */
    setValue(id) {
      const next = id == null ? '' : String(id);
      if (next && !findItem(next)) return;
      valueId = next;
      if (!open) syncClosedDisplay();
      else paintList();
    },
    getValue() {
      return valueId;
    },
    /** @param {string} text */
    setPlaceholder(text) {
      opts.placeholder = text;
      if (!open && !findItem(valueId)) input.placeholder = placeholder();
      else if (!open) input.placeholder = placeholder();
    },
    /** @param {string} text */
    setEmptyText(text) {
      opts.emptyText = text;
      if (open) paintList();
    },
    close,
    destroy() {
      document.removeEventListener('pointerdown', onDocPointer, true);
      close();
    }
  };
}
