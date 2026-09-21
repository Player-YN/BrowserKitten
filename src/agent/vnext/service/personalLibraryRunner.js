import { run as runCode } from '../primitives/run.js';
import { createCodeFsBridge } from '../sessionWorkspace/tools.js';
import { createGuestSys } from '../sessionWorkspace/browserSys.js';
import { createRunDeadline } from '../sessionWorkspace/runDeadline.js';
import { registerWrittenArtifacts } from '../sessionWorkspace/artifacts.js';

import { libraryError, validatePersonalLibraryInput } from './personalLibraryContract.js';
export { validatePersonalLibraryInput } from './personalLibraryContract.js';

/**
 * Execute a persisted personal Tool in the same QuickJS guest ABI as `run`.
 * The source is intentionally self-contained: it receives immutable `input`
 * data and may use fs/sys, but never gets extension globals or a creation
 * session file path.
 */
export async function runPersonalLibraryTool(entry, opts = {}) {
  if (!entry || entry.kind !== 'tool' || typeof entry.code !== 'string') {
    throw libraryError('LIBRARY_BAD_ENTRY', 'This library entry is not an executable tool.');
  }
  const input = validatePersonalLibraryInput(entry.parameters, opts.input);
  const fs = opts.fs;
  if (!fs) throw libraryError('LIBRARY_RUNTIME_UNAVAILABLE', 'Tool storage is unavailable.');
  const controller = opts.controller || new AbortController();
  const deadline = createRunDeadline(opts.timeoutMs || 30_000);
  const codeFs = createCodeFsBridge(fs);
  const hostSys = async (op, params, context) => {
    if (typeof opts.hostSys !== 'function') throw libraryError('SYS_DENIED', 'Browser access is unavailable.');
    return opts.hostSys(op, params, context);
  };
  const sys = createGuestSys({
    fs: codeFs,
    signal: controller.signal,
    deadline,
    defaultTabId: opts.activeTab?.tabId ?? opts.activeTab?.id ?? null,
    hostSys
  });
  // JSON.stringify is data encoding, never source concatenation of executable
  // parameter fragments. The stored entry code is the only executable source.
  const program = `const input = Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(input))}));\n${entry.code}`;
  const result = await runCode({ fs: codeFs, sys, signal: controller.signal, deadline, timeoutMs: opts.timeoutMs, runCode: opts.runCode }, {
    code: program, timeoutMs: opts.timeoutMs, deadline
  });
  const writtenFiles = [...new Set([...(result.writtenFiles || []), ...sys.writtenFiles])]
    .map(path => String(path).replace(/^\/output/, '/artifacts').replace(/^\/work/, '/scratch'));
  const { created, rejected: registrationErrors } = registerWrittenArtifacts(opts.store, fs, opts.sessionId, writtenFiles);
  const artifacts = created.map(rec => ({ artifactId: rec.artifactId, name: rec.name, path: rec.primaryPath }));
  return {
    ok: result.exitStatus === 0 && !result.error && !registrationErrors.length && !controller.signal.aborted,
    exitStatus: result.exitStatus,
    stdout: result.stdout || '', stderr: result.stderr || '',
    result: result.value ?? null, error: result.error || (controller.signal.aborted ? 'Execution cancelled.' : registrationErrors.length ? 'Some output files could not be registered.' : null),
    writtenFiles, artifacts, registrationErrors, duration: result.duration || 0
  };
}
