/**
 * run primitive (T8/T9) — model-facing tool over codeRuntime adapter.
 */

import { runCode } from '../adapters/codeRuntime.js';

/**
 * @param {object} ctx
 * @param {{ fs?: object, sys?: object, signal?: AbortSignal, timeoutMs?: number, runCode?: typeof runCode }} [ctx]
 * @param {{ code: string, entry?: string, entryFile?: string, files?: Record<string,string>, timeoutMs?: number }} input
 */
export async function run(ctx, input = {}) {
  if (!ctx || typeof ctx !== 'object') {
    return {
      exitStatus: 1,
      stdout: '',
      stderr: '',
      writtenFiles: [],
      duration: 0,
      error: 'run ctx required'
    };
  }

  const code = input.code != null ? String(input.code) : '';
  const entry = input.entry != null ? String(input.entry) : undefined;
  const entryFile = input.entryFile != null ? String(input.entryFile) : undefined;
  const files = input.files && typeof input.files === 'object' ? input.files : undefined;
  const timeoutMs = input.timeoutMs ?? ctx.timeoutMs;
  const signal = ctx.signal;
  const fs = ctx.fs || null;
  const sys = ctx.sys || null;
  const deadline = input.deadline || ctx.deadline;
  const exec = typeof ctx.runCode === 'function' ? ctx.runCode : runCode;

  return exec({
    code,
    entry,
    entryFile,
    files,
    signal,
    timeoutMs,
    deadline,
    fs,
    sys
  });
}

/**
 * AI-SDK-shaped tool. Only run — no acquire.
 * @param {{ fs?: object, sys?: object, signal?: AbortSignal, timeoutMs?: number, runCode?: Function }} ctx
 */
export function createRunTool(ctx) {
  return {
    name: 'run',
    description:
      'Guest JS/TS sandbox with fs (/context read-only, /artifacts durable, /scratch this turn) and sys (no chrome/window/document). ' +
      'sys.eval / sys.cdp program an already-open tab when action cannot change page policy. ISA: inspect view=sys. ' +
      'Failed calls return {ok:false, code, error, hint}.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript or TypeScript source to execute. ISA: inspect view=sys.' },
        entry: { type: 'string', description: 'Optional entry function name' },
        entryFile: { type: 'string', description: 'Optional virtual project entry filename' },
        files: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional virtual TS/JS source files keyed by path. Imports may use relative paths or pawwork:stdlib/*.'
        },
        timeoutMs: { type: 'number' }
      },
      required: ['code']
    },
    /**
     * @param {{ code: string, entry?: string, entryFile?: string, files?: Record<string,string>, timeoutMs?: number }} input
     */
    async execute(input = {}) {
      return run(ctx, input);
    },
    /**
     * @param {{ output?: any }} opts
     */
    toModelOutput(opts = {}) {
      const o = opts.output || {};
      return {
        type: 'json',
        value: {
          exitStatus: o.exitStatus,
          stdout: clip(o.stdout, 8000),
          stderr: clip(o.stderr, 4000),
          writtenFiles: o.writtenFiles || [],
          duration: o.duration,
          error: o.error || null
        }
      };
    }
  };
}

/**
 * @param {unknown} s
 * @param {number} n
 */
function clip(s, n) {
  const t = s == null ? '' : String(s);
  return t.length <= n ? t : t.slice(0, n) + '…';
}
