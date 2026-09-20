/**
 * Code runtime adapter (T8/T9) — QuickJS-WASM isolation (primary).
 *
 * Isolation guarantees:
 * - Guest code runs in a separate QuickJS WASM heap (no host globalThis).
 * - No chrome / window / document (including via globalThis / Function tricks).
 * - Injected: console + async fs RPC + sys (browser ABI via host).
 * - timeout + AbortSignal interrupt.
 *
 * Soft AsyncFunction path is emergency-only:
 *   opts.runtime === 'soft'  OR  process.env.BROWSERBOT_SOFT_SANDBOX=1
 *
 * Interface:
 *   runCode({ code, entry?, signal?, timeoutMs?, fs, sys, runtime? }) → RunResult
 *   codeRuntimeKind() → 'quickjs' | 'function-sandbox'
 */

/**
 * @typedef {object} RunResult
 * @property {number} exitStatus
 * @property {string} stdout
 * @property {string} stderr
 * @property {string[]} writtenFiles
 * @property {number} duration
 * @property {string} [error]
 * @property {unknown} [value]
 * @property {string} [runtime]  // 'quickjs' | 'soft'
 */

import { SYS_HELP } from '../sessionWorkspace/browserSys.js';
import { createRunDeadline } from '../sessionWorkspace/runDeadline.js';

/** @type {'quickjs' | 'function-sandbox'} */
let _activeKind = 'quickjs';

/**
 * Marker for replaceable adapter identity.
 * Default is QuickJS; soft path returns 'function-sandbox' only while active.
 * @returns {'quickjs' | 'function-sandbox'}
 */
export function codeRuntimeKind() {
  return _activeKind;
}

/**
 * @param {{
 *   code: string,
 *   entry?: string,
 *   entryFile?: string,
 *   files?: Record<string, string>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   fs?: object,
 *   globals?: Record<string, unknown>,
 *   runtime?: 'quickjs' | 'soft'
 * }} opts
 * @returns {Promise<RunResult>}
 */
export async function runCode(opts = {}) {
  const code = String(opts.code || '');
  const start = Date.now();

  const hasVirtualProject = opts.files && typeof opts.files === 'object' && Object.keys(opts.files).length > 0;
  if (!code.trim() && !hasVirtualProject) {
    return {
      exitStatus: 1,
      stdout: '',
      stderr: '',
      writtenFiles: [],
      duration: Date.now() - start,
      error: 'code required'
    };
  }

  if (opts.signal?.aborted) {
    return {
      exitStatus: 1,
      stdout: '',
      stderr: '',
      writtenFiles: [],
      duration: Date.now() - start,
      error: 'aborted before start'
    };
  }

  // Product extension path: execute generated source in a manifest-sandboxed
  // page that has no extension APIs. Node tests and the sandbox page itself
  // use the local QuickJS adapter below.
  const sandboxRunner = globalThis.__BROWSERBOT_CODE_SANDBOX_RUN__;
  if (typeof sandboxRunner === 'function' && opts.runtime !== 'local-quickjs' && opts.runtime !== 'soft') {
    try {
      const result = await sandboxRunner(opts);
      return { ...result, runtime: result?.runtime || 'quickjs-sandbox' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitStatus: 1,
        stdout: '',
        stderr: message,
        writtenFiles: [],
        duration: Date.now() - start,
        error: `sandboxed code runtime failed: ${message}`,
        runtime: 'quickjs-sandbox'
      };
    }
  }

  const wantSoft =
    opts.runtime === 'soft' ||
    (typeof process !== 'undefined' &&
      process.env &&
      (process.env.BROWSERBOT_SOFT_SANDBOX === '1' || process.env.BROWSERBOT_SOFT_SANDBOX === 'true'));

  if (wantSoft) {
    _activeKind = 'function-sandbox';
    const r = await runSoftSandbox(opts);
    r.runtime = 'soft';
    return r;
  }

  try {
    _activeKind = 'quickjs';
    const r = await runQuickJS(opts);
    r.runtime = 'quickjs';
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeBlockLog(e);
    return {
      exitStatus: 1,
      stdout: '',
      stderr: msg,
      writtenFiles: [],
      duration: Date.now() - start,
      error: `QuickJS runtime failed: ${msg}`,
      runtime: 'quickjs'
    };
  }
}

// ── QuickJS primary path ────────────────────────────────────────────────────

/**
 * Load QuickJS for the product host (Chrome MV3 extension) or Node tests.
 *
 * Order:
 *  1. Extension-relative vendored module (built by `npm run build:agent`)
 *     — works in sidepanel without node_modules resolution.
 *  2. Bare `quickjs-emscripten` — Node/dev only.
 *  3. Total failure → write honest t8-block.log and rethrow (fail closed).
 *     Soft sandbox is NOT a product fallback.
 *
 * @returns {Promise<{
 *   QuickJS: import('quickjs-emscripten-core').QuickJSWASMModule,
 *   shouldInterruptAfterDeadline: (deadline: Date|number) => () => boolean
 * }>}
 */
async function loadQuickJSApi() {
  /** @type {unknown} */
  let extensionErr = null;
  /** @type {unknown} */
  let nodeErr = null;

  // 1) Extension-shipped relative module (must not use bare package specifier)
  try {
    const v = await import('./vendor/quickjs-loader.mjs');
    const QuickJS = await v.getQuickJS();
    const shouldInterruptAfterDeadline =
      typeof v.shouldInterruptAfterDeadline === 'function'
        ? v.shouldInterruptAfterDeadline
        : null;
    return { QuickJS, shouldInterruptAfterDeadline };
  } catch (e1) {
    extensionErr = e1;
  }

  // 2) Node dev/test fallback (package resolution available)
  try {
    const q = await import('quickjs-emscripten');
    const QuickJS = await q.getQuickJS();
    return {
      QuickJS,
      shouldInterruptAfterDeadline: q.shouldInterruptAfterDeadline
    };
  } catch (e2) {
    nodeErr = e2;
  }

  // 3) Fail closed — do not soft-sandbox as product default
  const combined = new Error(
    `QuickJS load failed (extension vendor + node). ` +
      `extension: ${extensionErr instanceof Error ? extensionErr.message : String(extensionErr)}; ` +
      `node: ${nodeErr instanceof Error ? nodeErr.message : String(nodeErr)}`
  );
  await writeBlockLog({ extension: extensionErr, node: nodeErr, combined: combined.message });
  throw combined;
}

/**
 * @param {object} opts
 * @returns {Promise<RunResult>}
 */
async function runQuickJS(opts) {
  const codeIn = String(opts.code || '');
  const entry = opts.entry != null ? String(opts.entry) : null;
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const deadlineClock = opts.deadline && typeof opts.deadline.expiresAt === 'number'
    ? opts.deadline
    : createRunDeadline(timeoutMs);
  const signal = opts.signal;
  const start = Date.now();

  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  /** @type {string[]} */
  const writtenFiles = [];

  const sandboxFs = bindFs(opts.fs, writtenFiles);

  // Optional TS / modern syntax transpile
  let code = codeIn;
  try {
    code = await compileGuestSource({
      code: codeIn,
      files: opts.files,
      entryFile: opts.entryFile
    });
  } catch (te) {
    const message = te instanceof Error ? te.message : String(te);
    return {
      exitStatus: 1,
      stdout: '',
      stderr: `compile failed: ${message}`,
      writtenFiles: [],
      duration: Date.now() - start,
      error: `compile failed: ${message}`,
      runtime: 'quickjs'
    };
  }

  const { QuickJS, shouldInterruptAfterDeadline } = await loadQuickJSApi();

  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(clampMemoryLimit(opts.memoryLimitBytes));
  runtime.setMaxStackSize(1024 * 512);

  runtime.setInterruptHandler(() => Boolean(signal?.aborted) || Date.now() > deadlineClock.expiresAt);

  const vm = runtime.newContext();
  const hostDeferreds = createHostDeferredBag();

  try {
    injectConsole(vm, stdout, stderr);
    injectFs(vm, sandboxFs, hostDeferreds);
    injectSys(vm, opts.sys, hostDeferreds);
    injectSleep(vm, signal, hostDeferreds, deadlineClock);
    // Harden: privileged host APIs are absent. Access throws so adversarial
    // probes fail closed (exitStatus !== 0) rather than silently returning host data.
    // (QuickJS has its own globalThis — host chrome/window/document never leak.)
    vm.unwrapResult(
      vm.evalCode(`
        (function () {
          function deny(name) {
            Object.defineProperty(globalThis, name, {
              configurable: true,
              enumerable: false,
              get: function () {
                throw new Error(name + ' is not available in sandbox');
              },
              set: function () {
                throw new Error(name + ' is not available in sandbox');
              }
            });
          }
          var banned = [
            'chrome', 'window', 'document', 'self', 'frames', 'parent', 'top',
            'indexedDB', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'fetch',
            'caches', 'cookieStore', 'navigator', 'location'
          ];
          for (var i = 0; i < banned.length; i++) deny(banned[i]);
        })();
      `)
    ).dispose();

    const wrapped = wrapUserCode(code, entry);
    const evalResult = vm.evalCode(wrapped, 'task.js', { type: 'global' });
    if (evalResult.error) {
      const errVal = vm.dump(evalResult.error);
      evalResult.error.dispose();
      const msg = formatVmError(errVal);
      return {
        exitStatus: 1,
        stdout: stdout.join('\n'),
        stderr: (stderr.length ? stderr.join('\n') + '\n' : '') + msg,
        writtenFiles: unique(writtenFiles),
        duration: Date.now() - start,
        error: msg,
        runtime: 'quickjs'
      };
    }

    const promiseHandle = evalResult.value;
    // User code returns a Promise (async IIFE). Resolve it on the host.
    const settled = await raceVmPromise(vm, promiseHandle, timeoutMs, signal, deadlineClock);
    promiseHandle.dispose();

    if (settled.aborted) {
      return {
        exitStatus: 1,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        writtenFiles: unique(writtenFiles),
        duration: Date.now() - start,
        error: settled.error || 'aborted',
        runtime: 'quickjs'
      };
    }

    if (settled.error) {
      const msg = settled.error;
      return {
        exitStatus: 1,
        stdout: stdout.join('\n'),
        stderr: (stderr.length ? stderr.join('\n') + '\n' : '') + msg,
        writtenFiles: unique(writtenFiles),
        duration: Date.now() - start,
        error: msg,
        runtime: 'quickjs'
      };
    }

    return {
      exitStatus: 0,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      writtenFiles: unique(writtenFiles),
      duration: Date.now() - start,
      value: settled.value,
      runtime: 'quickjs'
    };
  } finally {
    // newPromise() holds resolve/reject until dispose. In-flight fs/sys RPCs
    // must drop those handles before JS_FreeRuntime or WASM aborts on
    // list_empty(&rt->gc_obj_list) and can take the offscreen renderer with it.
    hostDeferreds.disposeAll();
    try {
      vm.dispose();
    } catch {
      /* ignore dispose races */
    }
    try {
      runtime.dispose();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Wrap guest source so it always yields a Promise of the entry result.
 * @param {string} code
 * @param {string|null} entry
 */
function wrapUserCode(code, entry) {
  const entryJson = JSON.stringify(entry);
  return `
"use strict";
var module = { exports: {} };
var exports = module.exports;
(async function __pw_main() {
${code}

  if (typeof __pw_task_promise !== "undefined") {
    await __pw_task_promise;
  }

  var __entryName = ${entryJson};
  var __fn = null;
  if (typeof module.exports === "function") {
    __fn = module.exports;
  } else if (module.exports && __entryName && typeof module.exports[__entryName] === "function") {
    __fn = module.exports[__entryName];
  } else if (module.exports && typeof module.exports.default === "function") {
    __fn = module.exports.default;
  } else if (module.exports && typeof module.exports.main === "function") {
    __fn = module.exports.main;
  }
  if (typeof __fn === "function") {
    return await __fn();
  }
  return module.exports;
})();
`;
}

/**
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {string[]} stdout
 * @param {string[]} stderr
 */
function injectConsole(vm, stdout, stderr) {
  const logFn = vm.newFunction('log', (...args) => {
    const parts = args.map((h) => {
      try {
        return stringify(vm.dump(h));
      } catch {
        return String(h);
      }
    });
    stdout.push(parts.join(' '));
  });
  const infoFn = vm.newFunction('info', (...args) => {
    const parts = args.map((h) => stringify(safeDump(vm, h)));
    stdout.push(parts.join(' '));
  });
  const warnFn = vm.newFunction('warn', (...args) => {
    const parts = args.map((h) => stringify(safeDump(vm, h)));
    stderr.push(parts.join(' '));
  });
  const errorFn = vm.newFunction('error', (...args) => {
    const parts = args.map((h) => stringify(safeDump(vm, h)));
    stderr.push(parts.join(' '));
  });
  const debugFn = vm.newFunction('debug', (...args) => {
    const parts = args.map((h) => stringify(safeDump(vm, h)));
    stdout.push(parts.join(' '));
  });

  const consoleHandle = vm.newObject();
  vm.setProp(consoleHandle, 'log', logFn);
  vm.setProp(consoleHandle, 'info', infoFn);
  vm.setProp(consoleHandle, 'warn', warnFn);
  vm.setProp(consoleHandle, 'error', errorFn);
  vm.setProp(consoleHandle, 'debug', debugFn);
  vm.setProp(vm.global, 'console', consoleHandle);

  logFn.dispose();
  infoFn.dispose();
  warnFn.dispose();
  errorFn.dispose();
  debugFn.dispose();
  consoleHandle.dispose();
}

/** Track QuickJS deferreds from host fs/sys so teardown can free them. */
function createHostDeferredBag() {
  /** @type {Set<{ dispose?: () => void }>} */
  const pending = new Set();
  return {
    track(deferred) {
      if (deferred) pending.add(deferred);
      return deferred;
    },
    forget(deferred) {
      pending.delete(deferred);
    },
    disposeAll() {
      for (const deferred of pending) {
        try {
          deferred.dispose?.();
        } catch {
          /* already freed */
        }
      }
      pending.clear();
    }
  };
}

function releaseHostDeferred(handles, deferred) {
  handles?.forget?.(deferred);
  try {
    deferred?.dispose?.();
  } catch {
    /* already freed */
  }
}

/**
 * Inject async fs object (RPC-style promises).
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {object} sandboxFs
 * @param {ReturnType<typeof createHostDeferredBag>} handles
 */
function injectFs(vm, sandboxFs, handles) {
  const fsHandle = vm.newObject();

  const methods = ['readFile', 'writeFile', 'readdir', 'mkdir', 'stat', 'exists', 'remove', 'rm'];
  for (const name of methods) {
    const hostFn =
      typeof sandboxFs[name] === 'function'
        ? sandboxFs[name].bind(sandboxFs)
        : name === 'rm' && typeof sandboxFs.remove === 'function'
          ? sandboxFs.remove.bind(sandboxFs)
          : null;

    const fnHandle = vm.newFunction(name, (...argHandles) => {
      const args = argHandles.map((h) => safeDump(vm, h));
      const deferred = handles.track(vm.newPromise());

      if (!hostFn) {
        const errH = vm.newError(`${name} not available in this run`);
        deferred.reject(errH);
        errH.dispose();
        deferred.settled.then(() => {
          try {
            if (vm.alive) vm.runtime.executePendingJobs();
          } catch {
            /* ignore */
          }
          releaseHostDeferred(handles, deferred);
        });
        return deferred.handle;
      }

      Promise.resolve()
        .then(() => {
          // writeFile(path, data[, opts]): rehydrate binary from QuickJS dump
          // (Uint8Array → plain object with numeric keys) before host FS.
          if (name === 'writeFile' && args.length >= 2) {
            const data = rehydrateBinaryPayload(args[1]);
            return hostFn(args[0], data, args[2]);
          }
          return hostFn(...args);
        })
        .then((result) => {
          if (!vm.alive) return;
          const packed = hostValueToHandle(vm, result);
          deferred.resolve(packed.handle);
          if (packed.owned) {
            try {
              packed.handle.dispose();
            } catch {
              /* ignore */
            }
          }
        })
        .catch((err) => {
          if (!vm.alive) return;
          const msg = err instanceof Error ? err.message : String(err);
          const errH = vm.newError(msg);
          deferred.reject(errH);
          try {
            errH.dispose();
          } catch {
            /* ignore */
          }
        })
        .finally(() => {
          const finish = () => releaseHostDeferred(handles, deferred);
          if (!vm.alive) {
            finish();
            return;
          }
          deferred.settled.then(() => {
            try {
              vm.runtime.executePendingJobs();
            } catch {
              /* ignore */
            }
            finish();
          });
        });

      return deferred.handle;
    });

    vm.setProp(fsHandle, name, fnHandle);
    fnHandle.dispose();
  }

  vm.setProp(vm.global, 'fs', fsHandle);
  fsHandle.dispose();
}

/**
 * Inject sys — one host RPC plus a guest wrapper. help() is sync catalog.
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {{ call?: Function }|null|undefined} sys
 * @param {ReturnType<typeof createHostDeferredBag>} handles
 */
function injectSys(vm, sys, handles) {
  const hostCall = typeof sys?.call === 'function' ? sys.call.bind(sys) : null;
  const fnHandle = vm.newFunction('__pw_sys_call', (...argHandles) => {
    const op = String(safeDump(vm, argHandles[0]) || '');
    const params = argHandles.length > 1 ? safeDump(vm, argHandles[1]) : {};
    const deferred = handles.track(vm.newPromise());
    Promise.resolve()
      .then(() => {
        if (!hostCall) {
          const err = new Error('SYS_DENIED: browser sys has no host in this runtime');
          err.code = 'SYS_DENIED';
          throw err;
        }
        return hostCall(op, params && typeof params === 'object' ? params : {});
      })
      .then((result) => {
        if (!vm.alive) return;
        const packed = hostValueToHandle(vm, result);
        deferred.resolve(packed.handle);
        if (packed.owned) {
          try {
            packed.handle.dispose();
          } catch {
            /* ignore */
          }
        }
      })
      .catch((err) => {
        if (!vm.alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        const errH = vm.newError(msg);
        const codeH = vm.newString(String(err?.code || 'SYS_FAILED'));
        vm.setProp(errH, 'code', codeH);
        codeH.dispose();
        deferred.reject(errH);
        try {
          errH.dispose();
        } catch {
          /* ignore */
        }
      })
      .finally(() => {
        const finish = () => releaseHostDeferred(handles, deferred);
        if (!vm.alive) {
          finish();
          return;
        }
        deferred.settled.then(() => {
          try {
            vm.runtime.executePendingJobs();
          } catch {
            /* ignore */
          }
          finish();
        });
      });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__pw_sys_call', fnHandle);
  fnHandle.dispose();
  vm.unwrapResult(
    vm.evalCode(`
      (function () {
        var help = ${JSON.stringify(SYS_HELP)};
        globalThis.sys = {
          help: function () { return help; },
          capabilities: function () { return __pw_sys_call('capabilities', {}); },
          eval: function (opts) { return __pw_sys_call('eval', opts || {}); },
          waitFor: function (opts) { return __pw_sys_call('waitFor', opts || {}); },
          fetch: function (opts) { return __pw_sys_call('fetch', opts || {}); },
          cdp: function (opts) { return __pw_sys_call('cdp', opts || {}); },
          download: function (opts) { return __pw_sys_call('download', opts || {}); },
          screenshot: function (opts) { return __pw_sys_call('screenshot', opts || {}); },
          upload: function (opts) { return __pw_sys_call('upload', opts || {}); },
          tabs: {
            list: function (opts) { return __pw_sys_call('tabs.list', opts || {}); },
            current: function (opts) { return __pw_sys_call('tabs.current', opts || {}); },
            frames: function (opts) { return __pw_sys_call('tabs.frames', opts || {}); },
            open: function (opts) { return __pw_sys_call('tabs.open', opts || {}); },
            navigate: function (opts) { return __pw_sys_call('tabs.navigate', opts || {}); },
            reload: function (opts) { return __pw_sys_call('tabs.reload', opts || {}); },
            close: function (opts) { return __pw_sys_call('tabs.close', opts || {}); },
            focus: function (opts) { return __pw_sys_call('tabs.focus', opts || {}); }
          }
        };
      })();
    `)
  ).dispose();
}

/**
 * Inject a host-backed `sleep(ms)` global. QuickJS has no timers of its own, so
 * the host resolves the guest promise after a real setTimeout, bounded by the
 * run deadline and interruptible by the abort signal.
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {AbortSignal|undefined} signal
 * @param {ReturnType<typeof createHostDeferredBag>} handles
 * @param {number} deadline
 */
function injectSleep(vm, signal, handles, deadline) {
  const fnHandle = vm.newFunction('__pw_sleep', (msHandle) => {
    const raw = Number(safeDump(vm, msHandle));
    const deferred = handles.track(vm.newPromise());
    let ms = Number.isFinite(raw) ? raw : 0;
    ms = Math.max(0, Math.min(ms, 120_000));
    const expireAt = deadline && typeof deadline === 'object' && typeof deadline.expiresAt === 'number'
      ? deadline.expiresAt
      : Number(deadline);
    if (Number.isFinite(expireAt)) ms = Math.min(ms, Math.max(0, expireAt - Date.now()));

    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {(() => void)|null} */
    let onAbort = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        onAbort = null;
      }
    };
    const pumpThenRelease = () => {
      deferred.settled.then(() => {
        try { if (vm.alive) vm.runtime.executePendingJobs(); } catch { /* ignore */ }
        releaseHostDeferred(handles, deferred);
      });
    };
    const settleResolve = () => {
      cleanup();
      if (!vm.alive) { releaseHostDeferred(handles, deferred); return; }
      const value = vm.newNumber(ms);
      deferred.resolve(value);
      value.dispose();
      pumpThenRelease();
    };
    const settleReject = () => {
      cleanup();
      if (!vm.alive) { releaseHostDeferred(handles, deferred); return; }
      const errH = vm.newError('aborted');
      deferred.reject(errH);
      try { errH.dispose(); } catch { /* ignore */ }
      pumpThenRelease();
    };

    if (signal?.aborted) { settleReject(); return deferred.handle; }
    if (signal) { onAbort = () => settleReject(); signal.addEventListener('abort', onAbort, { once: true }); }
    timer = setTimeout(settleResolve, ms);
    return deferred.handle;
  });
  vm.setProp(vm.global, '__pw_sleep', fnHandle);
  fnHandle.dispose();
  vm.unwrapResult(
    vm.evalCode('globalThis.sleep = function (ms) { return __pw_sleep(ms); };')
  ).dispose();
}

/**
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {unknown} value
 * @returns {{ handle: import('quickjs-emscripten').QuickJSHandle, owned: boolean }}
 */
function hostValueToHandle(vm, value) {
  if (value === undefined) {
    return { handle: vm.undefined, owned: false };
  }
  if (value === null) {
    return { handle: vm.null, owned: false };
  }
  if (typeof value === 'boolean') {
    return { handle: value ? vm.true : vm.false, owned: false };
  }
  if (typeof value === 'number') {
    return { handle: vm.newNumber(value), owned: true };
  }
  if (typeof value === 'string') {
    return { handle: vm.newString(value), owned: true };
  }
  if (typeof value === 'bigint') {
    try {
      return { handle: vm.newBigInt(value), owned: true };
    } catch {
      return { handle: vm.newString(String(value)), owned: true };
    }
  }
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    try {
      const arr = Array.from(
        value instanceof Uint8Array ? value : new Uint8Array(value.buffer)
      );
      return hostValueToHandle(vm, arr);
    } catch {
      return { handle: vm.newString(''), owned: true };
    }
  }
  // objects / arrays — JSON round-trip into VM
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { handle: vm.undefined, owned: false };
    const evaled = vm.evalCode('(' + json + ')');
    if (evaled.error) {
      evaled.error.dispose();
      return { handle: vm.newString(String(value)), owned: true };
    }
    return { handle: evaled.value, owned: true };
  } catch {
    return { handle: vm.newString(String(value)), owned: true };
  }
}

/**
 * Await a QuickJS promise handle with timeout + abort.
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {import('quickjs-emscripten').QuickJSHandle} promiseHandle
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
async function raceVmPromise(vm, promiseHandle, timeoutMs, signal, deadlineClock) {
  // Drain any immediate microtasks
  try {
    vm.runtime.executePendingJobs();
  } catch {
    /* ignore */
  }

  const state = vm.getPromiseState(promiseHandle);
  if (state.type === 'fulfilled') {
    const v = safeDump(vm, state.value);
    try {
      state.value.dispose();
    } catch {
      /* ignore */
    }
    return { value: v };
  }
  if (state.type === 'rejected') {
    const errVal = safeDump(vm, state.error);
    try {
      state.error.dispose();
    } catch {
      /* ignore */
    }
    return { error: formatVmError(errVal) };
  }

  // Async path via resolvePromise
  let timer = null;
  let onAbort = null;
  let unsubDeadline = null;
  const timeoutPromise = new Promise((resolve) => {
    const arm = () => {
      if (timer) clearTimeout(timer);
      const remain = deadlineClock && typeof deadlineClock.remaining === 'function'
        ? deadlineClock.remaining()
        : timeoutMs;
      if (remain <= 0) {
        resolve({ aborted: true, error: `run timeout after ${timeoutMs}ms` });
        return;
      }
      timer = setTimeout(() => {
        if (deadlineClock && typeof deadlineClock.remaining === 'function' && deadlineClock.remaining() > 0) {
          arm();
          return;
        }
        resolve({ aborted: true, error: `run timeout after ${timeoutMs}ms` });
      }, remain);
    };
    arm();
    if (deadlineClock && typeof deadlineClock.subscribe === 'function') {
      unsubDeadline = deadlineClock.subscribe(arm);
    }
  });

  const abortPromise = signal
    ? new Promise((resolve) => {
        if (signal.aborted) {
          resolve({ aborted: true, error: 'aborted' });
          return;
        }
        onAbort = () => resolve({ aborted: true, error: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  let pump = null;
  const resolveNative = (async () => {
    // Pump jobs while waiting
    pump = setInterval(() => {
      try {
        vm.runtime.executePendingJobs();
      } catch {
        /* ignore */
      }
    }, 5);
    try {
      const result = await vm.resolvePromise(promiseHandle);
      try {
        vm.runtime.executePendingJobs();
      } catch {
        /* ignore */
      }
      if (result.error) {
        const errVal = safeDump(vm, result.error);
        result.error.dispose();
        return { error: formatVmError(errVal) };
      }
      const v = safeDump(vm, result.value);
      result.value.dispose();
      return { value: v };
    } finally {
      clearInterval(pump);
    }
  })();

  try {
    const racers = [resolveNative, timeoutPromise];
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (pump) clearInterval(pump);
    if (timer) clearTimeout(timer);
    if (typeof unsubDeadline === 'function') unsubDeadline();
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {import('quickjs-emscripten').QuickJSContext} vm
 * @param {import('quickjs-emscripten').QuickJSHandle} h
 */
function safeDump(vm, h) {
  try {
    return vm.dump(h);
  } catch {
    return undefined;
  }
}

/**
 * Rehydrate binary file bodies dumped from QuickJS guest handles.
 * vm.dump(Uint8Array) is often a plain object / array, not host Uint8Array.
 * @param {unknown} data
 * @returns {string|Uint8Array}
 */
function rehydrateBinaryPayload(data) {
  if (data == null) return new Uint8Array();
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data.map((n) => Number(n) & 0xff));
  }
  if (typeof data === 'object') {
    const o = /** @type {Record<string, unknown>} */ (data);
    if (o.type === 'Buffer' && Array.isArray(o.data)) {
      return new Uint8Array(o.data.map((n) => Number(n) & 0xff));
    }
    if (typeof o.length === 'number' && o.length >= 0 && Number.isFinite(o.length)) {
      const len = Math.min(Math.floor(o.length), 64 * 1024 * 1024);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = Number(o[i] ?? 0) & 0xff;
      return out;
    }
    const keys = Object.keys(o).filter((k) => /^\d+$/.test(k));
    if (keys.length > 0) {
      let max = -1;
      for (const k of keys) {
        const i = Number(k);
        if (i > max) max = i;
      }
      if (max >= 0 && max < 64 * 1024 * 1024) {
        const out = new Uint8Array(max + 1);
        for (const k of keys) out[Number(k)] = Number(o[k]) & 0xff;
        return out;
      }
    }
  }
  return data;
}

/**
 * @param {unknown} errVal
 */
function formatVmError(errVal) {
  if (errVal == null) return 'QuickJS error';
  if (typeof errVal === 'string') return errVal;
  if (typeof errVal === 'object') {
    if (/** @type {any} */ (errVal).message) return String(/** @type {any} */ (errVal).message);
    try {
      return JSON.stringify(errVal);
    } catch {
      return String(errVal);
    }
  }
  return String(errVal);
}

// ── Optional esbuild-wasm transpile ─────────────────────────────────────────

/** @type {Promise<any>|null} */
let _esbuildApi = null;

/**
 * @param {string} code
 * @returns {Promise<string>}
 */
async function maybeTranspile(code) {
  if (!looksLikeTsOrNeedsBundle(code)) return code;
  const esbuild = await loadEsbuildApi();
  const isTs = looksLikeTs(code);
  // A task-local snippet commonly uses top-level await. When TypeScript
  // syntax requires transpilation, place the source inside an async function
  // before esbuild so CJS output remains valid. wrapUserCode awaits the
  // resulting promise before resolving module.exports.
  const input = isTs
    ? `var __pw_task_promise = (async function () {\n${code}\n})();`
    : code;
  const result = await esbuild.transform(input, {
    loader: isTs ? 'ts' : 'js',
    format: 'cjs',
    target: 'es2020',
    platform: 'neutral',
    logLevel: 'silent'
  });
  return result.code || input;
}

/**
 * Compile a single TS/JS snippet or a small virtual multi-file project into a
 * single CommonJS bundle for QuickJS. Only bundled BrowserBot stdlib modules and
 * explicitly supplied virtual files may be imported; there is no npm/network
 * resolution in V0.
 */
async function compileGuestSource({ code, files, entryFile } = {}) {
  const source = String(code || '');
  const supplied = files && typeof files === 'object' ? { ...files } : {};
  const needsBundle = Boolean(entryFile || Object.keys(supplied).length || /\bimport\s+|\bexport\s+/.test(source));
  if (!needsBundle) return maybeTranspile(source);

  const esbuild = await loadEsbuildApi();
  const { BROWSERBOT_STDLIB_MODULES } = await import('./stdlib.js');
  const vfs = new Map();
  for (const [name, contents] of Object.entries(supplied)) {
    vfs.set(normalizeVirtualPath(name), String(contents));
  }
  const entryPath = normalizeVirtualPath(entryFile || '/entry.ts');
  if (source.trim()) vfs.set(entryPath, source);
  if (!vfs.has(entryPath)) throw new Error(`entry file not provided: ${entryPath}`);

  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'cjs',
    target: 'es2020',
    logLevel: 'silent',
    plugins: [{
      name: 'browserbot-virtual-modules',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (Object.prototype.hasOwnProperty.call(BROWSERBOT_STDLIB_MODULES, args.path)) {
            return { path: args.path, namespace: 'browserbot-stdlib' };
          }
          if (args.path.startsWith('.') || args.path.startsWith('/')) {
            const base = args.importer ? dirnameVirtual(args.importer) : '/';
            return { path: normalizeVirtualPath(args.path.startsWith('/') ? args.path : `${base}/${args.path}`), namespace: 'browserbot-vfs' };
          }
          if (vfs.has(normalizeVirtualPath(args.path))) {
            return { path: normalizeVirtualPath(args.path), namespace: 'browserbot-vfs' };
          }
          return { errors: [{ text: `Module not available in BrowserBot runtime: ${args.path}` }] };
        });
        build.onLoad({ filter: /.*/, namespace: 'browserbot-stdlib' }, (args) => ({
          contents: BROWSERBOT_STDLIB_MODULES[args.path],
          loader: 'js'
        }));
        build.onLoad({ filter: /.*/, namespace: 'browserbot-vfs' }, (args) => {
          if (!vfs.has(args.path)) return { errors: [{ text: `Virtual file not found: ${args.path}` }] };
          return { contents: vfs.get(args.path), loader: loaderForPath(args.path), resolveDir: dirnameVirtual(args.path) };
        });
      }
    }]
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error('esbuild produced no executable output');
  return output;
}

function normalizeVirtualPath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  const stack = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) throw new Error(`virtual path escapes root: ${value}`);
      stack.pop();
    } else stack.push(segment);
  }
  return '/' + stack.join('/');
}
function dirnameVirtual(path) {
  const normalized = normalizeVirtualPath(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}
function loaderForPath(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.json')) return 'json';
  return 'js';
}

function looksLikeTs(code) {
  return (
    /\binterface\s+\w+/.test(code) ||
    /\btype\s+\w+\s*=/.test(code) ||
    /:\s*(string|number|boolean|any|void|unknown|Record|Promise)\b/.test(code) ||
    /\bas\s+const\b/.test(code)
  );
}

function looksLikeTsOrNeedsBundle(code) {
  return looksLikeTs(code) || /\bimport\s+/.test(code) || /\bexport\s+/.test(code);
}

async function loadEsbuildApi() {
  if (_esbuildApi) return _esbuildApi;
  _esbuildApi = (async () => {
    // Node tests/dev use the package's native Node path, which is already
    // initialized and does not accept the browser-only wasmURL option.
    if (typeof process !== 'undefined' && process.versions?.node) {
      return import('esbuild-wasm');
    }
    // Product path: package-local vendored loader + WASM. No CDN or remote code.
    try {
      const api = await import('./vendor/esbuild-loader.mjs');
      try {
        await api.initialize({
          wasmURL: new URL('./vendor/esbuild.wasm', import.meta.url).href,
          worker: false
        });
      } catch (error) {
        // initialize() throws when already initialized; that is safe to ignore.
        if (!/initialize.*once|already initialized/i.test(String(error?.message || error))) throw error;
      }
      return api;
    } catch (vendorError) {
      throw vendorError;
    }
  })();
  return _esbuildApi;
}

// ── Soft sandbox (emergency only) ───────────────────────────────────────────

/**
 * @param {object} opts
 * @returns {Promise<RunResult>}
 */
async function runSoftSandbox(opts) {
  const code = String(opts.code || '');
  const entry = opts.entry != null ? String(opts.entry) : null;
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const signal = opts.signal;
  const start = Date.now();

  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  /** @type {string[]} */
  const writtenFiles = [];

  const sandboxFs = bindFs(opts.fs, writtenFiles);
  const sandboxConsole = {
    log: (...args) => {
      stdout.push(args.map(stringify).join(' '));
    },
    info: (...args) => {
      stdout.push(args.map(stringify).join(' '));
    },
    warn: (...args) => {
      stderr.push(args.map(stringify).join(' '));
    },
    error: (...args) => {
      stderr.push(args.map(stringify).join(' '));
    },
    debug: (...args) => {
      stdout.push(args.map(stringify).join(' '));
    }
  };

  const extraGlobals = opts.globals && typeof opts.globals === 'object' ? { ...opts.globals } : {};
  if (opts.sys && extraGlobals.sys == null) extraGlobals.sys = opts.sys;

  try {
    const value = await runInSoftSandbox({
      code,
      entry,
      fs: sandboxFs,
      console: sandboxConsole,
      extraGlobals,
      signal,
      timeoutMs
    });

    return {
      exitStatus: 0,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      writtenFiles: unique(writtenFiles),
      duration: Date.now() - start,
      value
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : '';
    const aborted =
      name === 'AbortError' || /aborted|timeout/i.test(msg) || signal?.aborted;

    if (aborted) {
      return {
        exitStatus: 1,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        writtenFiles: unique(writtenFiles),
        duration: Date.now() - start,
        error: msg || 'aborted'
      };
    }

    return {
      exitStatus: 1,
      stdout: stdout.join('\n'),
      stderr: (stderr.length ? stderr.join('\n') + '\n' : '') + msg,
      writtenFiles: unique(writtenFiles),
      duration: Date.now() - start,
      error: msg
    };
  }
}

/**
 * @param {object} args
 */
async function runInSoftSandbox(args) {
  const { code, entry, fs, console: sandboxConsole, extraGlobals, signal, timeoutMs } = args;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const body = `
"use strict";
const chrome = undefined;
const window = undefined;
const document = undefined;
const self = undefined;
const frames = undefined;
const parent = undefined;
const top = undefined;
const indexedDB = undefined;
const localStorage = undefined;
const sessionStorage = undefined;
const XMLHttpRequest = undefined;
const fetch = typeof __pw_fetch === "function" ? __pw_fetch : undefined;

const module = { exports: {} };
let exports = module.exports;

${code}

const __entryName = __pw_entry;
let __fn = null;
if (typeof module.exports === "function") {
  __fn = module.exports;
} else if (module.exports && __entryName && typeof module.exports[__entryName] === "function") {
  __fn = module.exports[__entryName];
} else if (module.exports && typeof module.exports.default === "function") {
  __fn = module.exports.default;
} else if (module.exports && typeof module.exports.main === "function") {
  __fn = module.exports.main;
}
if (typeof __fn === "function") {
  return await __fn();
}
return module.exports;
`;

  const fn = new AsyncFunction(
    'fs',
    'console',
    '__pw_entry',
    '__pw_fetch',
    ...Object.keys(extraGlobals),
    body
  );

  const runPromise = fn(
    fs,
    sandboxConsole,
    entry,
    extraGlobals.fetch || undefined,
    ...Object.values(extraGlobals)
  );

  return await raceTimeout(runPromise, timeoutMs, signal);
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
function raceTimeout(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {(() => void)|null} */
    let onAbort = null;

    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(v);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`run timeout after ${timeoutMs}ms`);
        err.name = 'AbortError';
        finish(reject, err);
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        finish(reject, err);
        return;
      }
      onAbort = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        finish(reject, err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e)
    );
  });
}

// ── FS bind + utils ─────────────────────────────────────────────────────────

/**
 * Bind task fs; track written paths. Session guest roots are /artifacts and /scratch
 * (legacy /work and /output are remapped by the host bridge).
 * @param {object|null|undefined} fs
 * @param {string[]} writtenFiles
 */
function bindFs(fs, writtenFiles) {
  if (!fs || typeof fs !== 'object') {
    return {
      async readFile() {
        throw new Error('fs not available in this run');
      },
      async writeFile() {
        throw new Error('fs not available in this run');
      },
      async readdir() {
        return [];
      },
      async exists() {
        return false;
      },
      async mkdir() {
        return null;
      },
      async stat() {
        throw new Error('fs not available in this run');
      },
      async remove() {
        throw new Error('fs not available in this run');
      }
    };
  }

  return {
    async readFile(path, encoding) {
      const v = await Promise.resolve(fs.readFile(path, encoding));
      if (v == null && encoding !== 'binary') {
        throw new Error(`ENOENT: ${path}`);
      }
      return v;
    },
    readdir: (...a) => Promise.resolve(fs.readdir ? fs.readdir(...a) : []),
    exists: async (...a) => {
      if (fs.exists) return !!(await Promise.resolve(fs.exists(...a)));
      try {
        const v = await Promise.resolve(fs.readFile(a[0]));
        return v != null;
      } catch {
        return false;
      }
    },
    mkdir: (...a) => Promise.resolve(fs.mkdir ? fs.mkdir(...a) : null),
    stat: (...a) =>
      Promise.resolve(fs.stat ? fs.stat(...a) : Promise.reject(new Error('stat not available'))),
    async writeFile(path, data, opts) {
      const payload = rehydrateBinaryPayload(data);
      const result = await Promise.resolve(fs.writeFile(path, payload, opts));
      const p = (result && result.path) || String(path);
      writtenFiles.push(p);
      return result || { path: p };
    },
    async remove(...a) {
      if (fs.remove) return Promise.resolve(fs.remove(...a));
      if (fs.rm) return Promise.resolve(fs.rm(...a));
      throw new Error('remove not available');
    }
  };
}

/**
 * @param {unknown} v
 */
function stringify(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * @param {number|undefined} ms
 */
function clampTimeout(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return 15_000;
  return Math.max(1, Math.min(Number(ms), 120_000));
}

function clampMemoryLimit(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return 64 * 1024 * 1024;
  return Math.max(8 * 1024 * 1024, Math.min(Number(bytes), 256 * 1024 * 1024));
}

/**
 * @param {string[]} arr
 */
function unique(arr) {
  return [...new Set(arr)];
}

/**
 * Honest failure log when QuickJS cannot load/run.
 * Does not soft-sandbox; surfaces MV3/CWS/path blocks for Criterion 5.
 * @param {unknown} err
 */
async function writeBlockLog(err) {
  let msg;
  if (err && typeof err === 'object' && !(err instanceof Error) && ('extension' in err || 'node' in err)) {
    const o = /** @type {{ extension?: unknown, node?: unknown, combined?: string }} */ (err);
    const ext =
      o.extension instanceof Error
        ? `${o.extension.message}\n${o.extension.stack || ''}`
        : String(o.extension ?? '');
    const node =
      o.node instanceof Error
        ? `${o.node.message}\n${o.node.stack || ''}`
        : String(o.node ?? '');
    msg =
      (o.combined ? o.combined + '\n' : '') +
      `--- extension vendor ---\n${ext}\n--- node fallback ---\n${node}`;
  } else if (err instanceof Error) {
    msg = `${err.message}\n${err.stack || ''}`;
  } else {
    msg = String(err);
  }
  const line = `[${new Date().toISOString()}] QuickJS blocked/failed:\n${msg}\n`;

  if (typeof process === 'undefined' || !process.versions?.node) {
    console.error('[codeRuntime]', line);
    return;
  }

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const candidates = [
      process.env?.BROWSERBOT_SCRATCH ? path.join(process.env.BROWSERBOT_SCRATCH, 't8-block.log') : null,
      path.join(os.tmpdir(), 't8-block.log')
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.appendFile(p, line, 'utf8');
        return;
      } catch {
        /* try next */
      }
    }
  } catch {
    console.error('[codeRuntime]', line);
  }
}
