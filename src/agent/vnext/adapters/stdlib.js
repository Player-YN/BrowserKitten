/** Bundled, dependency-free BrowserBot standard-library source modules. */
export const BROWSERBOT_STDLIB_MODULES = Object.freeze({
  'browserbot:stdlib/csv': `
    export function escapeCsv(value) {
      const text = value == null ? '' : String(value);
      const quote = text.includes(',') || text.includes('\"') || text.includes(String.fromCharCode(10)) || text.includes(String.fromCharCode(13));
      return quote ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    export function rowsToCsv(rows, columns) {
      const list = Array.isArray(rows) ? rows : [];
      const cols = Array.isArray(columns) && columns.length
        ? columns
        : Array.from(new Set(list.flatMap(row => row && typeof row === 'object' ? Object.keys(row) : [])));
      return [cols.map(escapeCsv).join(','), ...list.map(row => cols.map(col => escapeCsv(row?.[col])).join(','))].join(String.fromCharCode(10));
    }
  `,
  'browserbot:stdlib/html': `
    export function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    export function htmlDocument({ title = 'Browser Kitten Output', body = '', styles = '' } = {}) {
      return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + escapeHtml(title) + '</title><style>' + styles + '</style></head><body>' + body + '</body></html>';
    }
    export function tableHtml(rows, columns) {
      const list = Array.isArray(rows) ? rows : [];
      const cols = Array.isArray(columns) && columns.length ? columns : Array.from(new Set(list.flatMap(row => Object.keys(row || {}))));
      return '<table><thead><tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead><tbody>' +
        list.map(row => '<tr>' + cols.map(c => '<td>' + escapeHtml(row?.[c]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }
  `,
  'browserbot:stdlib/table': `
    export function select(rows, columns) {
      return (Array.isArray(rows) ? rows : []).map(row => Object.fromEntries(columns.map(column => [column, row?.[column]])));
    }
    export function groupBy(rows, key) {
      const out = Object.create(null);
      for (const row of Array.isArray(rows) ? rows : []) {
        const value = typeof key === 'function' ? key(row) : row?.[key];
        const name = String(value ?? '');
        (out[name] ||= []).push(row);
      }
      return out;
    }
    export function sortBy(rows, key, direction = 'asc') {
      const factor = direction === 'desc' ? -1 : 1;
      return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
        const av = typeof key === 'function' ? key(a) : a?.[key];
        const bv = typeof key === 'function' ? key(b) : b?.[key];
        return av < bv ? -factor : av > bv ? factor : 0;
      });
    }
  `,
  'browserbot:stdlib/runtime': `
    export const fs = globalThis.fs;
    export const sys = globalThis.sys;
    export async function writeJson(path, value, spacing = 2) {
      await fs.writeFile(path, JSON.stringify(value, null, spacing));
    }
    export async function readJson(path) {
      return JSON.parse(await fs.readFile(path));
    }
  `
});
