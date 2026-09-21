import { validateWorkflow } from '../workflow/definition.js';
/** Small, versioned contract shared by draft review and deterministic execution. */
export function libraryError(code, message) {
  return Object.assign(new Error(message), { code });
}

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safeName = name => !['__proto__', 'prototype', 'constructor'].includes(name);
const typed = (value, type) => type === 'integer' ? Number.isSafeInteger(value)
  : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;

export function validatePersonalLibrarySchema(schema = {}) {
  if (!plain(schema) || Object.keys(schema).some(k => !['type', 'properties', 'required', 'additionalProperties'].includes(k)) ||
      (schema.type != null && schema.type !== 'object') ||
      (schema.additionalProperties != null && schema.additionalProperties !== false) ||
      (schema.properties != null && !plain(schema.properties)) ||
      (schema.required != null && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string')))) {
    throw libraryError('LIBRARY_BAD_SCHEMA', 'Parameters must use the supported object schema.');
  }
  const props = schema.properties || {};
  for (const [name, rule] of Object.entries(props)) {
    if (!safeName(name) || !plain(rule) || !['string', 'number', 'integer', 'boolean'].includes(rule.type) ||
        Object.keys(rule).some(k => !['type', 'title', 'description', 'default', 'enum'].includes(k)) ||
        ['title', 'description'].some(k => rule[k] != null && typeof rule[k] !== 'string') ||
        (rule.enum != null && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.some(v => !typed(v, rule.type)))) ||
        (Object.hasOwn(rule, 'default') && (!typed(rule.default, rule.type) || (rule.enum && !rule.enum.includes(rule.default))))) {
      throw libraryError('LIBRARY_BAD_SCHEMA', `Unsupported parameter schema: ${name}.`);
    }
  }
  for (const key of schema.required || []) if (!Object.hasOwn(props, key)) {
    throw libraryError('LIBRARY_BAD_SCHEMA', `Required parameter is not declared: ${key}.`);
  }
  return schema;
}

export function validatePersonalLibraryInput(schema = {}, input = {}) {
  validatePersonalLibrarySchema(schema);
  if (!plain(input)) throw libraryError('LIBRARY_BAD_INPUT', 'Parameters must be an object.');
  const out = {};
  for (const [name, rule] of Object.entries(schema.properties || {})) {
    const value = Object.hasOwn(input, name) ? input[name] : rule.default;
    if (value === undefined) continue;
    if (!typed(value, rule.type) || (rule.enum && !rule.enum.includes(value))) {
      throw libraryError('LIBRARY_BAD_INPUT', `Invalid parameter: ${name}.`);
    }
    out[name] = value;
  }
  for (const key of schema.required || []) if (!Object.hasOwn(out, key)) throw libraryError('LIBRARY_BAD_INPUT', `Missing required parameter: ${key}.`);
  for (const key of Object.keys(input)) if (!Object.hasOwn(schema.properties || {}, key)) throw libraryError('LIBRARY_BAD_INPUT', `Unsupported parameter: ${key}.`);
  return out;
}

export function validatePersonalLibraryDefinition(entry) {
  if (entry?.kind === 'workflow' && entry.workflow) {
    if (entry.runtimeVersion !== 'browserbot-library-v1') throw libraryError('LIBRARY_BAD_RUNTIME', 'Unknown library runtime.');
    if (typeof entry.name !== 'string' || !entry.name.trim()) throw libraryError('LIBRARY_DRAFT_NOT_READY', 'Name is required.');
    validatePersonalLibrarySchema(entry.parameters ?? {});
    validateWorkflow(entry.workflow, { parameters: entry.parameters || {} });
    return entry;
  }
  if (!plain(entry) || !['tool', 'workflow'].includes(entry.kind) || typeof entry.name !== 'string' || !entry.name.trim() ||
      typeof entry[entry.kind === 'tool' ? 'code' : 'instructions'] !== 'string' || !entry[entry.kind === 'tool' ? 'code' : 'instructions'].trim()) {
    throw libraryError('LIBRARY_DRAFT_NOT_READY', 'The draft needs a name and a complete definition.');
  }
  if (entry.runtimeVersion !== 'browserbot-library-v1') throw libraryError('LIBRARY_BAD_RUNTIME', 'Unknown library runtime.');
  validatePersonalLibrarySchema(entry.parameters ?? {});
  return entry;
}

export function personalLibraryManifestPatch(manifest, draft) {
  const allowed = ['draftId', 'kind', 'name', 'description', 'parameters', 'runtimeVersion', 'code', 'instructions', 'workflow', 'scope', 'allowedHosts'];
  if (!plain(manifest) || ['draftId', 'kind', 'name', 'description', 'parameters', 'runtimeVersion'].some(k => !Object.hasOwn(manifest, k)) ||
      Object.keys(manifest).some(k => !allowed.includes(k)) || manifest.draftId !== draft.draftId || manifest.kind !== draft.kind ||
      (manifest.kind === 'tool' && Object.hasOwn(manifest, 'instructions')) || (manifest.kind === 'workflow' && Object.hasOwn(manifest, 'code'))) {
    throw libraryError('LIBRARY_BAD_DRAFT', 'Draft identity, kind, or fields do not match the creation contract.');
  }
  if (draft.workflow && !manifest.workflow) throw libraryError('LIBRARY_BAD_DRAFT', 'A structured workflow cannot become a playbook implicitly.');
  if (manifest.workflow) {
    if (manifest.runtimeVersion !== 'browserbot-library-v1') throw libraryError('LIBRARY_BAD_RUNTIME', 'Unknown library runtime.');
    validatePersonalLibrarySchema(manifest.parameters);
    validateWorkflow(manifest.workflow, { partial: true, parameters: manifest.parameters });
  } else validatePersonalLibraryDefinition(manifest);
  const { draftId, ...patch } = manifest;
  return patch;
}

export function requireLibraryRevision(expectedRevision, actualRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw libraryError('LIBRARY_BAD_INPUT', 'An explicit reviewed revision is required.');
  if (expectedRevision !== actualRevision) throw libraryError('LIBRARY_CONFLICT', 'The draft changed. Refresh and review it again.');
}
