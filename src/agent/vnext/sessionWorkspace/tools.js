/**
 * Always-on tools for Session Workspace general agent.
 * inspect / acquire / run — host-enforced auth + real code runtime.
 *
 * HARD: SelectionGroups / WebItems / sessionBindings are NOT mutable via tools.
 * Only user/UI RPC (createGroup, bindGroups, syncTabSelection, …) may change them.
 * Guest run(code) has guest FS + sys (browser ABI). No store, no chrome.*, no group APIs.
 */

import { SYS_ABI } from '../../../brand.js';
import { acquireLease } from './execution.js';
import {
  createArtifact,
  updateArtifactContent,
  listArtifacts,
  registerWrittenArtifacts
} from './artifacts.js';
import { getBoundGroupsCompact, listGroupItems } from './groups.js';
import {
  assertGroupReadable,
  assertItemReadable,
  assertArtifactOwned,
  isItemBoundToSession
} from './auth.js';
import { run as runCodePrimitive } from '../primitives/run.js';
import { acquire as acquirePrimitive } from '../primitives/acquire.js';
import { generateSessionImage } from './imageGen.js';
import { routeMediaInput } from './mediaInput.js';
import { transcribeSessionAudio } from './transcribe.js';
import { executeListenAction } from './listenAction.js';
import {
  assignmentRequestsDelete,
  bindClickAssignmentNames,
  executorVision,
  fetchExecutorStep,
  plannerClickAssignment,
  runDelegateLoop
} from './delegateExecutor.js';
import { runOffscreenChoose } from './chooseAction.js';
import { byokAllowedForProvider, BYOK_PLAN_MESSAGE, BYOK_REQUIRES_PLAN } from '../../byokGate.js';
import { guessMimeFromName } from './artifactValidate.js';
import { coerceToUint8Array } from './fs.js';
import { createRunDeadline, clampRunTimeout } from './runDeadline.js';
import { readHtmlPreviewKind } from './htmlPreviewMarker.js';
import {
  getSkill,
  listPackagedSkillCatalog,
  loadSkillInstructions,
  loadSkillResource,
  resolveSkillId,
  skillIdAliases,
  skillResourcePaths
} from '../skills/registry.js';
import {
  getDurableSkillStore,
  mergeSkillCatalog,
  mergeSkillRecord,
  skillRecordFromMarkdown,
  importSkillFromUrl,
  normalizeDurableSkill,
  writeSkillPackToGuest
} from './skillStore.js';
import { ensureItemPixels, looksLikeImageItem } from './itemPixels.js';
import { ensureItemLabel, labeledItemView, resolveBoundItemRef } from './itemLabel.js';
import { resolveAcquireFetch } from './pageItems.js';
import {
  newClarifyId,
  normalizeClarifyQuestions,
  waitForClarifyAnswer
} from './clarifyGate.js';
import {
  classifyPlanDecision,
  normalizePlan,
  pinFrozenPlan,
  unpinFrozenPlan,
  wantsDurableTaskFromPlan
} from './planContract.js';
import { startTaskFromPlanApproval } from './tasks.js';
import { ensureSessionAgentsMd } from './sessionAgentsMd.js';
import { moveArtifactToTrash } from './workspaceTrash.js';
import {
  applyCommandsToWorkbookData,
  capRangeRead,
  inspectSheetSelection,
  overviewFromWorkbookData,
  sheetsToWorkbookData,
  workbookDataToSheets,
  normalizeCommands,
  classifySheetImageSrc,
  hydrateSheetGridCommands
} from './sheetApply.js';
import { inspectHtml } from './htmlApply.js';
import { hydrateDocCommands } from './officePathHydrate.js';
import { htmlWritePolicy } from './htmlWritePolicy.js';
import { rememberVisualCreation, resolveWorkbookCreateTarget } from './visualCreationLedger.js';
import { stampSiteHtml, listSiteNodes, pinnedSiteIds, siteSelectionsFromIds } from './siteApply.js';
import { SITE_MOTION_CAPABILITY } from './siteMotionSchema.js';
import { guestPathToDataUrl, isGuestArtifactPath, rewriteGuestImageSrcs } from './htmlMedia.js';
import { applyDocCommands, emptyDocSnapshot } from './docsApply.js';
import { pdfBytesToHtml, looksLikePdf, PDF_RECONSTRUCTION_WARNING } from './pdfIngest.js';
import { classifyOpenArtifact, isUtf8OpenKind } from './openClassify.js';
import { resolveHtmlUpsertTarget } from './htmlArtboard.js';
import { createOfficeTools } from './officeTools.js';
import { sessionToolToModelOutput } from './canvasPreview.js';
import { actionToModelOutput } from './actionObserve.js';
import {
  compactShelfSnapshot,
  setArtifactFolder,
  setShelfMeta
} from './artifactShelf.js';
import { hydrateOfficeImageCommands, hydrateSheetImageCommands, HTML_IMAGE_OPS, officeImageRef, resolveOfficeAsset } from './sheetImageHydrate.js';
import {
  aoaToCsv,
  bytesToUtf8,
  isSheetArtifact,
  parseDelimited,
  sheetKindFromArtifact
} from '../../../preview/sheetCodec.js';
import { pageBytes, pageTextByCodePoint } from './textPage.js';
import { createGuestSys, SYS_HELP } from './browserSys.js';
import { createTaskTool, guardTaskToolExecutions } from './taskTool.js';
import {
  learnedReuseBlocked,
  yieldLearnPlanConfirm,
  learnConfirmPlan,
  markLearnedReuseConfirmed,
  parseCapabilityRoutes
} from './learnFromTrajectory.js';

/**
 * @param {object} env
 * @param {import('./store.js').SessionWorkspaceStore} env.store
 * @param {object} env.execution
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} env.fs
 * @param {string} env.sessionId
 * @param {AbortSignal} [env.signal]
 * @param {typeof fetch} [env.fetchImpl]
 */
export function createSessionTools(env) {
  const { store, execution, fs, sessionId } = env;
  const signal = env.signal || execution?.abortSignal;
  const fetchImpl = env.fetchImpl || globalThis.fetch;
  const onEvent = typeof env.onEvent === 'function' ? env.onEvent : null;

  function emitLiveCanvasUpdated(artifactId) {
    if (!onEvent || !artifactId) return;
    try {
      onEvent({ type: 'html_canvas_updated', sessionId, artifactId });
    } catch {
      /* UI listener must not fail the tool */
    }
  }

  function htmlPreviewKind(content) {
    const head =
      typeof content === 'string'
        ? content.slice(0, 8000)
        : content instanceof Uint8Array
          ? new TextDecoder().decode(content.slice(0, 8000))
          : String(content || '').slice(0, 8000);
    if (/data-browserbot-kind\s*=\s*["'](site|web)["']/i.test(head)) return 'site';
    return readHtmlPreviewKind(content);
  }

  function emitHtmlPreviewIfMarked(rec, content) {
    if (!onEvent || !rec || !execution) return;
    let bytes = content;
    if (bytes == null && rec.primaryPath) {
      try {
        bytes = fs.readFileBytes(rec.primaryPath);
      } catch {
        return;
      }
    }
    const kind = htmlPreviewKind(bytes);
    if (kind !== 'blocks' && kind !== 'site') return;
    if (!execution.htmlPreviewEmitted) {
      execution.htmlPreviewEmitted = true;
      try {
        onEvent({
          type: 'artifact_preview',
          sessionId,
          artifactId: rec.artifactId,
          kind,
          name: rec.name,
          path: rec.primaryPath
        });
      } catch {
        /* UI listener must not fail the tool */
      }
      return;
    }
    emitHtmlCanvasUpdated(rec);
  }

  function emitHtmlCanvasUpdated(rec) {
    if (!onEvent || !rec) return;
    try {
      onEvent({
        type: 'html_canvas_updated',
        sessionId,
        artifactId: rec.artifactId
      });
    } catch {
      /* UI listener must not fail the tool */
    }
  }

  function assignShelfFolder(artifactId, folder) {
    const dest = String(folder || '').trim().toLowerCase();
    if (dest === 'trash' || dest === '.trash') {
      return moveArtifactToTrash(store, fs, sessionId, String(artifactId || ''));
    }
    return setArtifactFolder(store, sessionId, String(artifactId || ''), folder);
  }

  function executeShelfOp(input = {}) {
    const commands = Array.isArray(input.commands) ? input.commands : [];
    const applied = [];
    if (input.artifactId && (input.folder || input.shelf)) {
      const one = assignShelfFolder(input.artifactId, input.folder || input.shelf);
      if (!one.ok) return { ok: false, op: 'shelf', error: one.error, code: one.code };
      applied.push({ op: 'setFolder', artifactId: String(input.artifactId), folder: one.artifact.folder });
    }
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== 'object') continue;
      const cop = String(cmd.op || cmd.act || '');
      if (cop === 'setFolder' || cop === 'set') {
        const one = assignShelfFolder(cmd.artifactId, cmd.folder || cmd.shelf || cmd.label);
        if (!one.ok) return { ok: false, op: 'shelf', error: one.error, code: one.code, applied };
        applied.push({ op: 'setFolder', artifactId: one.artifact.artifactId, folder: one.artifact.folder });
      } else if (cop === 'renameFolder') {
        const id = String(cmd.folder || cmd.id || '');
        const label = String(cmd.label || cmd.name || '').trim();
        if (!id || !label) continue;
        setShelfMeta(store, sessionId, { labels: { [id]: label } });
        applied.push({ op: 'renameFolder', folder: id, label });
      } else if (cop === 'setLayout') {
        const layout = Array.isArray(cmd.folders) ? cmd.folders : cmd.layout;
        if (!Array.isArray(layout)) continue;
        setShelfMeta(store, sessionId, { layout });
        applied.push({ op: 'setLayout', n: layout.length });
      }
    }
    const arts = listArtifacts(store, sessionId);
    const sess = store.get('sessions', sessionId) || {};
    const shelf = compactShelfSnapshot(arts, sess.shelf);
    if (onEvent) {
      try {
        onEvent({ type: 'artifact_shelf_updated', sessionId, shelf });
      } catch {
        /* UI listener must not fail the tool */
      }
    }
    return {
      ok: true,
      op: 'shelf',
      applied,
      shelf
    };
  }

  function loadWorkbookFromArtifact(artifactId) {
    const gate = assertArtifactOwned(store, sessionId, artifactId);
    if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
    const rec = gate.record;
    if (!isSheetArtifact(rec)) {
      return {
        ok: false,
        error: 'artifact is not a spreadsheet',
        code: 'NOT_SHEET',
        hint: 'pass a csv or tsv artifact id'
      };
    }
    const bytes = fs.readFileBytes(rec.primaryPath);
    const kind = sheetKindFromArtifact(rec);
    if (kind === 'xlsx') {
      return {
        ok: false,
        error: 'xlsx is not parsed here',
        code: 'BAD_INPUT',
        rec
      };
    }
    const text = bytesToUtf8(bytes);
    const sheets = [{ name: 'Sheet1', rows: parseDelimited(text, kind) }];
    return { ok: true, rec, kind, sheets, data: sheetsToWorkbookData(sheets, rec.name) };
  }

  const inspect = {
    name: 'inspect',
    description:
      'Look up this session, read-only: bound groups/items, artifacts, guest files, skill playbooks, workbook/range samples, HTML/canvas structure, or the sys ABI catalog. Does not mutate and does not execute sys. File reads (view=files + a file path): offset is a Unicode code-point offset (binary: byte offset); maxChars bounds the returned slice; response includes offset, nextOffset, totalChars, eof. Directory listings still use offset/limit.',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['groups', 'group', 'item', 'artifacts', 'files', 'skill', 'workbook', 'range', 'html', 'sys'],
          description:
            `Which surface to read. view=sys returns the browser ABI catalog (${SYS_ABI}); it does not call sys.`
        },
        plateId: { type: 'string', description: 'HTML plate id (view=html)' },
        slotId: { type: 'string', description: 'HTML slot id (view=html)' },
        a1: { type: 'string', description: 'A1 range (view=range)' },
        sheet: { type: 'string', description: 'Sheet name (view=range)' },
        artifactId: { type: 'string', description: 'Artifact id; workbook/range default to the focused workbook' },
        groupId: { type: 'string' },
        itemId: { type: 'string', description: 'Item id or sticky handle (image1 / 图片1)' },
        skillId: { type: 'string', description: 'Skill catalog id (view=skill)' },
        path: { type: 'string' },
        offset: {
          type: 'number',
          description:
            'Directory listing offset, or Unicode code-point offset when reading a file (binary files: byte offset)'
        },
        limit: { type: 'number', description: 'Listing page size' },
        maxChars: {
          type: 'number',
          description: 'Returned text bound for file reads (Unicode code points; default 12000, max 50000)'
        },
        includeMedia: { type: 'boolean', description: 'Include image bytes for multimodal item inspect' }
      }
    },
    async execute(input = {}) {
      const view = String(input.view || 'groups');
      if (view === 'sys') {
        return { ok: true, view, ...SYS_HELP };
      }
      if (view === 'groups') {
        return { ok: true, view, groups: getBoundGroupsCompact(store, sessionId) };
      }
      if (view === 'group') {
        const groupId = String(input.groupId || '');
        const gate = assertGroupReadable(store, sessionId, groupId);
        if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
        const offset = Math.max(0, Number(input.offset) || 0);
        const limit = Math.max(1, Math.min(Number(input.limit) || 50, 100));
        const all = listGroupItems(store, groupId);
        const page = all.slice(offset, offset + limit).map((it) => {
          const labeled = ensureItemLabel(store, it, { groupId }).item;
          const handle = labeledItemView(labeled);
          return {
            webItemId: labeled.webItemId,
            kindHint: labeled.kindHint,
            handle: handle?.handle || '',
            label: handle?.label || '',
            preview: summarizeCapture(labeled.capture)
          };
        });
        for (const it of page) acquireLease(store, execution, it.webItemId);
        return {
          ok: true,
          view,
          groupId,
          items: page,
          total: all.length,
          offset,
          limit,
          hasMore: offset + limit < all.length
        };
      }
      if (view === 'item') {
        const itemRef = input.itemId || input.item || input.handle || '';
        const itemId = resolveBoundItemRef(store, sessionId, itemRef) || String(itemRef || '');
        const gate = assertItemReadable(store, sessionId, itemId);
        if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
        const item = store.get('items', itemId);
        acquireLease(store, execution, itemId);
        const media = await materializeItemMedia(store, item, input.includeMedia !== false, {
          fetchImpl,
          signal,
          onEvent
        });
        // modelParts live only at top level (toModelOutput input) — duplicating
        // them inside `item` doubles every image payload downstream.
        const { modelParts: itemModelParts, ...mediaMeta } = media;
        const labeled = ensureItemLabel(store, item).item;
        const handle = labeledItemView(labeled);
        return {
          ok: true,
          view,
          item: {
            webItemId: labeled.webItemId,
            kindHint: labeled.kindHint,
            handle: handle?.handle || '',
            label: handle?.label || '',
            capture: stripHeavyCapture(labeled.capture),
            text: labeled.capture?.text || labeled.capture?.preview?.textSnippet || null,
            src: compactSrc(labeled.capture?.src) || null,
            ...mediaMeta
          },
          /** Model-facing multimodal parts when pixels available */
          modelParts: itemModelParts || []
        };
      }
      if (view === 'workbook' || view === 'range') {
        const sess = store.get('sessions', sessionId) || {};
        const artifactId =
          String(input.artifactId || sess.activeWorkbook?.artifactId || '').trim();
        if (!artifactId) {
          return {
            ok: true,
            view,
            overview: sess.activeWorkbook?.overview || null
          };
        }
        const loaded = loadWorkbookFromArtifact(artifactId);
        if (!loaded.ok) return loaded;
        if (view === 'range') {
          const read = inspectSheetSelection(loaded.data, input.a1 || 'A1:Z20', input.sheet);
          return {
            ok: true,
            view,
            artifactId,
            overview: overviewFromWorkbookData(loaded.data),
            ...read
          };
        }
        return {
          ok: true,
          view,
          artifactId,
          overview: overviewFromWorkbookData(loaded.data)
        };
      }
      if (view === 'html') {
        const sess = store.get('sessions', sessionId) || {};
        const artifactId = String(
          input.artifactId || sess.activeHtml?.artifactId || sess.activeWorkbook?.artifactId || ''
        ).trim();
        if (!artifactId) return { ok: false, view, error: 'no html artifact' };
        const gate = assertArtifactOwned(store, sessionId, artifactId);
        if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
        const rec = listArtifacts(store, sessionId).find((a) => a.artifactId === artifactId);
        if (!rec) return { ok: false, view, error: 'artifact not found' };
        let html = '';
        try {
          html = bytesToUtf8(fs.readFileBytes(rec.primaryPath));
        } catch (e) {
          return { ok: false, view, error: e instanceof Error ? e.message : String(e) };
        }
        const selected = pinnedSiteIds(sess.activeHtml?.selections);
        if (/data-browserbot-kind\s*=\s*["']site["']/i.test(html)) {
          const nodes = listSiteNodes(html);
          return {
            ok: true,
            view,
            artifactId,
            kind: 'site',
            nodes,
            available: nodes.map((n) => n.nodeId),
            selected,
            selections: siteSelectionsFromIds(html, selected),
            motion: SITE_MOTION_CAPABILITY
          };
        }
        const inspected = inspectHtml(html, { plateId: input.plateId, slotId: input.slotId });
        return { ok: inspected.ok !== false, view, artifactId, selected, ...inspected };
      }
      if (view === 'artifacts') {
        return {
          ok: true,
          view,
          artifacts: listArtifacts(store, sessionId).map((a) => ({
            id: a.artifactId,
            name: a.name,
            path: a.primaryPath,
            mimeType: a.mimeType,
            size: a.size,
            folder: a.folder || ''
          })),
          shelf: compactShelfSnapshot(
            listArtifacts(store, sessionId),
            (store.get('sessions', sessionId) || {}).shelf
          )
        };
      }
      if (view === 'files') {
        const path = String(input.path || '/artifacts');
        const maxChars = Math.max(500, Math.min(Number(input.maxChars) || 12000, 50000));
        if (path === '/scratch' || path.startsWith('/scratch/skills')) {
          await hydrateSkillScriptsIntoGuest(fs);
        }
        try {
          if (fs.exists(path) && !path.endsWith('/')) {
            try {
              const bytes = fs.readFileBytes(path);
              const textLike = isProbablyText(path, bytes);
              const offset = Math.max(0, Number(input.offset) || 0);
              if (textLike) {
                const text = new TextDecoder().decode(bytes);
                const page = pageTextByCodePoint(text, offset, maxChars);
                return {
                  ok: true,
                  view,
                  path,
                  content: page.content,
                  truncated: page.truncated,
                  offset: page.offset,
                  nextOffset: page.nextOffset,
                  totalChars: page.totalChars,
                  eof: page.eof,
                  unit: page.unit,
                  size: bytes.byteLength
                };
              }
              const bin = pageBytes(bytes, offset, Math.min(maxChars, 4096));
              return {
                ok: true,
                view,
                path,
                content: null,
                truncated: bin.truncated,
                offset: bin.offset,
                nextOffset: bin.nextOffset,
                totalChars: bin.totalBytes,
                eof: bin.eof,
                unit: bin.unit,
                bytes: bin.bytes,
                size: bytes.byteLength
              };
            } catch (e) {
              if (!/ENOENT/i.test(e instanceof Error ? e.message : String(e))) throw e;
            }
          }
          const listing = fs.list(path);
          const offset = Math.max(0, Number(input.offset) || 0);
          const limit = Math.max(1, Math.min(Number(input.limit) || 100, 200));
          return {
            ok: true,
            view,
            path,
            listing: listing.slice(offset, offset + limit),
            total: listing.length,
            offset,
            limit,
            hasMore: offset + limit < listing.length
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (view === 'skill' || view === 'skills') {
        const requestedId = String(input.skillId || input.id || '').trim();
        if (!requestedId) {
          return {
            ok: true,
            view: 'skills',
            catalog: mergeSkillCatalog(
              listPackagedSkillCatalog(),
              await getDurableSkillStore().list()
            ).map((s) => ({ id: s.id, name: s.name, description: s.description }))
          };
        }
        const skillId = resolveSkillId(requestedId);
        const packed = getSkill(skillId);
        const durable = await getDurableSkillStore().get(requestedId);
        const skill = mergeSkillRecord(packed, durable);
        if (!skill) {
          return {
            ok: false,
            error: `unknown skill ${requestedId}`,
            code: 'NOT_FOUND',
            hint: 'inspect view=skill without skillId to list the catalog'
          };
        }
        const resourcePath = String(input.path || '').trim();
        const playbookRaw =
          durable?.instructions || loadSkillInstructions(skillId, { sessionId }) || skill.instructions || '';
        const playbook = typeof playbookRaw === 'function' ? playbookRaw() : playbookRaw;
        if (learnedReuseBlocked(durable || skill)) {
          const target = durable || skill;
          const classified = await yieldLearnPlanConfirm({
            sessionId,
            plan: learnConfirmPlan(
              {
                taskClass: target.taskClass || target.id,
                name: target.name,
                description: target.description,
                routes: parseCapabilityRoutes(target.instructions || playbook),
                discovery: 'If the preferred route fails, re-enter discovery.'
              },
              { reuse: true }
            ),
            onEvent,
            signal,
            waitForClarify: typeof env.waitForClarify === 'function' ? env.waitForClarify : waitForClarifyAnswer
          });
          if (classified.kind !== 'approved') {
            return {
              ok: false,
              view: 'skill',
              skillId,
              code: 'LEARN_REUSE_DENIED',
              error: 'First reuse of a learned method requires plan-card confirm.',
              playbook: ''
            };
          }
          await markLearnedReuseConfirmed(target.id || skillId);
        }
        if (resourcePath) {
          const resolved = resolveSkillGuestResource(requestedId, resourcePath);
          if (resolved.kind === 'playbook') {
            return { ok: true, view: 'skill', skillId, path: resolved.path, content: playbook };
          }
          const fromDurable = durable?.resources?.[resolved.path];
          const content =
            fromDurable != null ? fromDurable : await loadSkillResource(skillId, resolved.path);
          if (content == null) {
            return {
              ok: false,
              error: `unknown skill resource ${resourcePath}`,
              code: 'NOT_FOUND',
              hint: 'inspect view=skill without path to list resourcePaths'
            };
          }
          return { ok: true, view: 'skill', skillId, path: resolved.path, content };
        }
        return {
          ok: true,
          view: 'skill',
          skillId,
          name: skill.name,
          description: skill.description,
          origin: skill.origin || 'packaged',
          playbook,
          resources: skillResourcePaths(skill),
          guestRoot: `/scratch/skills/${skillId}`
        };
      }
      return {
        ok: false,
        error: `unknown view ${view}`,
        code: 'BAD_INPUT',
        hint: 'use inspect view=groups|item|files|workbook|range|skill|html|sys'
      };
    },
    /**
     * Prefer multimodal parts when inspect returned image bytes.
     * @param {{ output?: any }} opts
     */
    toModelOutput(opts = {}) {
      const o = opts.output || {};
      if (Array.isArray(o.modelParts) && o.modelParts.length) {
        const value = [];
        for (const p of o.modelParts) {
          if (!p || typeof p !== 'object') continue;
          if (p.type === 'text' && p.text) {
            value.push({ type: 'text', text: String(p.text) });
            continue;
          }
          if ((p.type === 'file' || p.type === 'file-data') && (p.data || p.image)) {
            const raw = typeof p.data === 'object' && p.data?.data != null ? p.data.data : p.data ?? p.image;
            const data = typeof raw === 'string' ? raw : bytesToBase64(raw);
            if (data) {
              value.push({
                type: 'file',
                data: { type: 'data', data },
                mediaType: p.mediaType || 'image/png'
              });
            }
            continue;
          }
          if (p.type === 'image') {
            const raw = p.image ?? p.data;
            const data = typeof raw === 'string' ? raw : bytesToBase64(raw);
            if (data) {
              value.push({
                type: 'file',
                data: { type: 'data', data },
                mediaType: p.mediaType || 'image/png'
              });
            }
          }
        }
        if (value.length) return { type: 'content', value };
      }
      const json = { ...o };
      delete json.modelParts;
      delete json.imageBase64;
      return { type: 'json', value: json };
    }
  };

  const acquire = {
    toModelOutput: sessionToolToModelOutput,
    name: 'acquire',
    description:
      'Bring unknown public web into this session (search, fetch, map, crawl, note, image, transcribe). Anonymous — no user cookies. Do not use for a URL the user already has open, or that needs their login, cookies, captcha, Referer, or this-machine IP: that is run + sys.fetch as:"page". action=fetch url accepts a public http(s) URL or a bound page alias (页面N / pageN / wi_…). Downloadable public audio/video: fetch delivers supported media to your own input, otherwise STT/NEED_STT; do not listen to the file again. fetch path reads already-saved media (e.g. sys.fetch). transcribe explicitly uses the separate STT API.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'fetch', 'map', 'crawl', 'note', 'image', 'transcribe'] },
        query: {
          type: 'string',
          description: 'Search string; optional in-site filter for map'
        },
        url: {
          type: 'string',
          description:
            'Public http(s) URL for fetch, map, crawl, or transcribe. Not for an already-open tab or a login/captcha/IP-bound link.'
        },
        text: { type: 'string', description: 'Note body' },
        filename: { type: 'string' },
        limit: { type: 'number', description: 'Hit cap for search/map; crawl page count is host-capped' },
        prompt: { type: 'string', description: 'Image generation prompt' },
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bound image handles or WebItem ids for image-to-image'
        },
        allowText: {
          type: 'boolean',
          description: 'Image only. When true, generation may include lettering. Default false.'
        },
        aspect_ratio: { type: 'string' },
        model: { type: 'string', description: 'Optional image or transcription model override' },
        path: { type: 'string', description: 'Saved media path for fetch (own model input) or transcribe (STT); /scratch or /artifacts' },
        artifactId: { type: 'string', description: 'Session artifact to transcribe' },
        language: { type: 'string', description: 'Optional BCP-47 language hint for transcribe' }
      },
      required: ['action']
    },
    async execute(input = {}) {
      if (signal?.aborted) return { ok: false, error: 'aborted' };
      const action = String(input.action || 'note');
      fs.mkdirp('/scratch/sources');

      if (action === 'fetch' && input.path) {
        const path = String(input.path);
        if (!fs.exists(path)) return { ok: false, code: 'ENOENT', path };
        return routeMediaInput({ ...env, store, fs, sessionId, signal, fetchImpl }, { ok: true, action, path, bytes: fs.readFileBytes(path).length });
      }

      if (action === 'transcribe') {
        return transcribeSessionAudio({
          store,
          fs,
          sessionId,
          path: input.path,
          artifactId: input.artifactId,
          url: input.url,
          model: input.model,
          language: input.language,
          fetchImpl: fetchImpl || globalThis.fetch,
          signal,
          settings: env.settings
        });
      }

      if (action === 'image') {
        const prompt = String(input.prompt || '').trim();
        if (!prompt) {
          return {
            ok: false,
            action: 'image',
            code: 'MISSING_PROMPT',
            error: 'image needs prompt',
            hint: 'retry acquire action=image with prompt'
          };
        }
        return generateSessionImage({
          store,
          fs,
          sessionId,
          prompt,
          filename: input.filename,
          itemIds: input.itemIds,
          allowText: input.allowText === true,
          aspectRatio: input.aspect_ratio || input.aspectRatio,
          model: input.model,
          fetchImpl: fetchImpl || globalThis.fetch,
          signal,
          onEvent,
          settings: env.settings
        });
      }

      if (action === 'note') {
        const body = JSON.stringify(
          { action: 'note', text: input.text || null, at: Date.now() },
          null,
          2
        );
        const path = `/scratch/sources/note_${Date.now().toString(36)}.json`;
        fs.writeFile(path, body, { mimeType: 'application/json' });
        return { ok: true, action, path };
      }

      // Real search/fetch via shared primitive; map /work/sources → /scratch/sources
      const codeFs = createCodeFsBridge(fs);
      let fetchUrl = input.url;
      let fetchMeta = null;
      if (action === 'fetch') {
        const resolved = await resolveAcquireFetch(
          {
            store,
            sessionId,
            fs,
            hostFindTab: env.hostFindTab,
            hostPageCapture: env.hostPageCapture
          },
          input
        );
        if (!resolved.ok) return resolved;
        if (resolved.pathUsed === 'content-script' && !resolved.deferFetch) {
          return resolved;
        }
        fetchUrl = resolved.url;
        fetchMeta = resolved;
      }
      const result = await acquirePrimitive(
        {
          fs: codeFs,
          signal,
          fetchImpl: fetchImpl || globalThis.fetch,
          webAcquire: env.webAcquire
        },
        {
          action,
          query: input.query,
          url: fetchUrl,
          filename: input.filename,
          limit: input.limit
        }
      );
      // Remap reported path for session guest
      if (result?.path && String(result.path).startsWith('/work/sources/')) {
        result.path = '/scratch/sources/' + String(result.path).slice('/work/sources/'.length);
      }
      if (result && typeof result === 'object') {
        const out = { ...result };
        delete out.provider;
        if (out.source && out.source !== 'http') out.source = 'scrape';
        if (fetchMeta) {
          out.pathUsed = 'fetch';
          if (fetchMeta.itemId) out.itemId = fetchMeta.itemId;
          if (fetchMeta.via) out.via = fetchMeta.via;
        }
        if (action === 'fetch' && out.ok && out.path) {
          return routeMediaInput({ ...env, store, fs, sessionId, signal, fetchImpl }, out);
        }
        return out;
      }
      return result;
    }
  };

  const run = {
    name: 'run',
    description:
      'Guest JS/TS sandbox with fs (/context read-only, /artifacts durable, /scratch this turn) and sys (no chrome/window/document). ' +
      'op registers persist/scratch/document/html; code executes. Everyday canvas edits use doc or web. csv and xlsx are files, not a sheet tool. ' +
      'sys.eval / sys.cdp program an already-open tab when action cannot change page policy. ISA: inspect view=sys. ' +
      'Failed calls return {ok:false, code, error, hint}.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript or TypeScript source to execute. ISA: inspect view=sys.'
        },
        entry: { type: 'string' },
        entryFile: { type: 'string' },
        files: { type: 'object', additionalProperties: { type: 'string' } },
        timeoutMs: {
          type: 'number',
          description:
            'If this program calls sys.waitFor, timeoutMs must be >= that wait (waitFor default 30000, max 120000). Host will also extend the run deadline to cover an in-flight waitFor. Default 15000.'
        },
        op: {
          type: 'string',
          enum: RUN_OPS,
          description:
            'Registration ABI. Aliases normalize at runtime (createDocument→doc). Omit and pass code: execute on the guest machine. Categories: persist (write_artifact, update_artifact, write_package_file); scratch (write_scratch, read); register document (doc, createDocument); register site (write_artifact + data-browserbot-kind=site); register pdf-derived (ingestPdf); shelf; skill. Daily edits use doc or web, not these ops.'
        },
        name: { type: 'string' },
        artifactId: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        mimeType: { type: 'string' },
        kind: { type: 'string', description: 'File kind to register: workbook (csv / json-workbook / …)' },
        artifactMode: {
          type: 'string',
          description:
            'Omit to reuse/fail-close. "new" registers at most one extra same-kind file this turn, then reuses it. Explicit artifactId always wins.'
        },
        title: { type: 'string' },
        html: { type: 'string' },
        commands: {
          type: 'array',
          description: 'Registration commands for the chosen op — not daily office edits.',
          items: { type: 'object' }
        }
      }
    },
    async execute(input = {}) {
      if (signal?.aborted) return { ok: false, error: 'aborted' };

      const opEarly = String(input.op || '');
      if (opEarly === 'skill') {
        return executeSkillOp(input, { fetchImpl, signal });
      }
      if (opEarly === 'shelf') {
        return executeShelfOp(input);
      }
      const sceneFirst = isSceneRunInput(input, opEarly);
      const sheetFirst = false;

      // ── Code execution path (product coding runtime) ──
      if (!sheetFirst && input.code != null && String(input.code).trim() !== '') {
        await hydrateSkillScriptsIntoGuest(fs);
        const codeText = String(input.code);
        if (codeText.length > 24000) {
          return {
            ok: false,
            op: 'code',
            error:
              'code exceeds 24000 chars. Write a csv or tsv file instead of embedding the grid. There is no sheet tool.'
          };
        }
        const codeFs = createCodeFsBridge(fs);
        const sysController = new AbortController();
        const cancelSys = () => sysController.abort();
        const sysTimeout = clampRunTimeout(input.timeoutMs);
        const runDeadline = createRunDeadline(sysTimeout);
        let sysTimer = setTimeout(cancelSys, Math.max(1, runDeadline.remaining()));
        const unsubDeadline = runDeadline.subscribe(() => {
          clearTimeout(sysTimer);
          const remain = runDeadline.remaining();
          if (remain <= 0) cancelSys();
          else sysTimer = setTimeout(cancelSys, remain);
        });
        signal?.addEventListener('abort', cancelSys, { once: true });
        if (signal?.aborted) cancelSys();
        const sys = createGuestSys({
          fs: codeFs,
          signal: sysController.signal,
          deadline: runDeadline,
          hostSys: typeof env.hostSys === 'function' ? env.hostSys : null,
          defaultTabId: env.activeTab?.tabId ?? env.activeTab?.id ?? null,
          onEvent,
          sessionId
        });
        let result;
        try {
          result = await runCodePrimitive(
            { fs: codeFs, sys, signal, timeoutMs: input.timeoutMs, deadline: runDeadline },
            {
              code: String(input.code),
              entry: input.entry,
              entryFile: input.entryFile,
              files: input.files,
              timeoutMs: input.timeoutMs,
              deadline: runDeadline
            }
          );
        } finally {
          unsubDeadline();
          clearTimeout(sysTimer);
          signal?.removeEventListener('abort', cancelSys);
          cancelSys();
        }
        const written = [...new Set([...(Array.isArray(result.writtenFiles) ? result.writtenFiles : []), ...sys.writtenFiles])];
        const guestWritten = written.map(mapHostToGuest).filter(Boolean);
        const { created, rejected } = registerWrittenArtifacts(store, fs, sessionId, guestWritten);
        for (const rec of created) emitHtmlPreviewIfMarked(rec);
        const truthFail = rejected.length > 0;
        const visionParts = Array.isArray(sys.visionParts) ? sys.visionParts : [];
        return {
          ok: result.exitStatus === 0 && !result.error && !truthFail,
          op: 'code',
          exitStatus: result.exitStatus,
          stdout: result.stdout,
          stderr: result.stderr,
          writtenFiles: guestWritten.length ? guestWritten : written,
          duration: result.duration,
          ...(visionParts.length ? { modelParts: visionParts } : {}),
          error:
            result.error ||
            (truthFail
              ? `artifact truth rejected: ${rejected.map((r) => `${r.path}: ${r.error}`).join('; ')}`
              : null),
          runtime: result.runtime || null,
          rejected,
          artifacts: created.map((a) => ({
            id: a.artifactId,
            name: a.name,
            path: a.primaryPath
          }))
        };
      }

      let op = String(input.op || '') || (sheetFirst ? 'sheet' : sceneFirst ? 'html' : '');
      if (REMOVED_SCENE_OPS.has(op)) op = 'html';
      if (op === 'html') {
        return {
          ok: false,
          op,
          code: 'OP_REMOVED',
          error: 'There is no canvas HTML op. HTML files are a website or a document.',
          hint: 'Use run op=doc for a document, or write_artifact with data-browserbot-kind=site for a website.'
        };
      }
      if (op === 'doc') {
        let commands = Array.isArray(input.commands) ? input.commands : [];
        if (!commands.length && (input.html || input.content || input.title || input.name || opEarly === 'createDocument')) {
          commands = [{ op: 'createDocument', title: input.title || input.name }];
          if (input.html || input.content) {
            commands.push({ op: 'setText', text: String(input.html || input.content) });
          }
        }
        const hydratedDoc = hydrateDocCommands(fs, commands);
        if (!hydratedDoc.ok) {
          return {
            ok: false,
            op,
            code: hydratedDoc.code,
            error: hydratedDoc.error,
            hint: hydratedDoc.hint
          };
        }
        commands = hydratedDoc.commands;
        if (!commands.length) return { ok: false, op, error: 'doc requires commands[]' };
        const applied = applyDocCommands(emptyDocSnapshot(input.name || 'Document'), commands);
        if (applied.ok === false) {
          return {
            ok: false,
            op,
            error: applied.error || 'doc apply failed',
            applied: applied.applied
          };
        }
        const rec = createArtifact(store, fs, {
          sessionId,
          name: String(input.name || 'document.html').replace(/[^\w.\u4e00-\u9fff-]+/g, '_') || 'document.html',
          content: applied.html,
          mimeType: 'text/html'
        });
        emitHtmlPreviewIfMarked(rec, applied.html);
        return { ok: true, op, artifact: rec, applied: applied.applied, snapshot: applied.snapshot };
      }
      if (op === 'ingestPdf') {
        const sess = store.get('sessions', sessionId) || {};
        const artifactId = String(input.artifactId || '').trim();
        if (!artifactId) return { ok: false, op, error: 'ingestPdf needs artifactId' };
        const rec = listArtifacts(store, sessionId).find((a) => a.artifactId === artifactId);
        if (!rec) return { ok: false, op, error: 'artifact not found' };
        let bytes;
        try {
          bytes = coerceToUint8Array(fs.readFileBytes(rec.primaryPath));
        } catch (e) {
          return { ok: false, op, error: e instanceof Error ? e.message : String(e) };
        }
        const converted = await pdfBytesToHtml(bytes, { title: rec.name || 'PDF' });
        const out = createArtifact(store, fs, {
          sessionId,
          name: String(rec.name || 'pdf').replace(/\.pdf$/i, '') + '.html',
          content: converted.html,
          mimeType: 'text/html'
        });
        emitHtmlPreviewIfMarked(out, converted.html);
        return {
          ok: true,
          op,
          artifact: out,
          warning: converted.warning,
          pageCount: converted.pageCount,
          pdf: looksLikePdf(bytes)
        };
      }
      if (op === 'write_artifact') {
        try {
          const name =
            input.name || (input.mimeType && /html/i.test(input.mimeType) ? 'result.html' : 'result');
          let content = input.content || '';
          const policy = htmlWritePolicy(content, name);
          if (policy.allow === false) {
            return { ok: false, op, code: policy.code, error: policy.error, hint: policy.hint };
          }
          if (policy.kind === 'site') content = stampSiteHtml(content);
          const sess = store.get('sessions', sessionId) || {};
          const existing = resolveHtmlUpsertTarget(store, sessionId, {
            name,
            content,
            activeId: sess.activeHtml?.artifactId || ''
          });
          if (existing) {
            const rec = updateArtifactContent(store, fs, sessionId, existing.artifactId, content, {
              mimeType: input.mimeType || existing.mimeType
            });
            emitHtmlPreviewIfMarked(rec, content);
            return { ok: true, op, artifact: rec, updated: true };
          }
          const rec = createArtifact(store, fs, {
            sessionId,
            name,
            content,
            mimeType: input.mimeType
          });
          emitHtmlPreviewIfMarked(rec, content);
          return { ok: true, op, artifact: rec };
        } catch (e) {
          return {
            ok: false,
            op,
            error: e instanceof Error ? e.message : String(e),
            code: e?.code || 'WRITE_FAILED'
          };
        }
      }
      if (op === 'update_artifact') {
        try {
          const content = input.content || '';
          const policy = htmlWritePolicy(content, input.name || '');
          if (policy.allow === false) {
            return { ok: false, op, code: policy.code, error: policy.error, hint: policy.hint };
          }
          const rec = updateArtifactContent(
            store,
            fs,
            sessionId,
            String(input.artifactId),
            policy.kind === 'site' ? stampSiteHtml(content) : content,
            { mimeType: input.mimeType }
          );
          return { ok: true, op, artifact: rec };
        } catch (e) {
          return {
            ok: false,
            op,
            error: e instanceof Error ? e.message : String(e),
            code: e?.code || 'UPDATE_FAILED'
          };
        }
      }
      if (op === 'write_scratch') {
        const path = String(input.path || `/scratch/work_${Date.now().toString(36)}.txt`);
        fs.writeFile(path, String(input.content || ''));
        return { ok: true, op, path };
      }
      if (op === 'read') {
        const path = String(input.path || '');
        try {
          // Auth: artifact paths are session-scoped via guest FS jail
          if (path.startsWith('/artifacts/')) {
            // optional: ensure path belongs to an owned artifact package
          }
          return { ok: true, op, path, content: fs.readFile(path) };
        } catch (e) {
          return { ok: false, op, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (op === 'write_package_file') {
        const gate = assertArtifactOwned(store, sessionId, String(input.artifactId));
        if (!gate.ok) return { ok: false, op, error: gate.error, code: gate.code };
        const packPolicy = htmlWritePolicy(input.content || '', String(input.path || input.name || ''));
        if (packPolicy.allow === false) {
          return { ok: false, op, code: packPolicy.code, error: packPolicy.error };
        }
        const { writePackageFile } = await import('./artifacts.js');
        try {
          const r = writePackageFile(store, fs, {
            sessionId,
            artifactId: String(input.artifactId),
            path: String(input.path),
            content: input.content || '',
            mimeType: input.mimeType
          });
          return { ok: true, op, ...r };
        } catch (e) {
          return { ok: false, op, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!op && (input.code == null || String(input.code).trim() === '')) {
        return {
          ok: false,
          error: 'run requires code or op',
          code: 'BAD_INPUT',
          hint: 'pass op (write_artifact / doc / …) or code'
        };
      }
      return {
        ok: false,
        error: `unknown op ${op}`,
        code: 'BAD_INPUT',
        hint: 'use a documented run op from the tool schema enum'
      };
    },
    toModelOutput: sessionToolToModelOutput
  };

  const waitClarify =
    typeof env.waitForClarify === 'function' ? env.waitForClarify : waitForClarifyAnswer;

  const clarify = {
    name: 'clarify',
    description:
      'Pause this turn and yield to the user. Use questions (1–4) when intent is actually unclear, or a plan card when the work is complex or they invoked /plan. Present the plan itself — do not ask whether to enter plan mode. Do not mutate until they approve, refuse, or send revision notes; if they require changes, yield a revised card this turn — do not execute the old contract.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Shorthand for a single question' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Shorthand option labels for a single question'
        },
        questions: {
          type: 'array',
          description: '1–4 clarifying questions',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' }
                  }
                }
              }
            }
          }
        },
        plan: {
          type: 'object',
          description: 'Plan card to pin after approval. Shape is in the properties below.',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            steps: {
              type: 'array',
              description: 'Irreversible moves. Prefer { title, detail }; a string is a title only.',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: 'Short irreversible move' },
                      detail: {
                        type: 'string',
                        description: 'What and why; shown when the user expands the step'
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      }
    },
    async execute(input = {}, opts = {}) {
      const plan = normalizePlan(input.plan);
      const questions = plan
        ? []
        : normalizeClarifyQuestions(input);
      if (!plan && !questions.length) {
        return {
          ok: false,
          error: 'clarify requires a question or a plan',
          code: 'BAD_INPUT',
          hint: 'pass question, questions[], or plan { title, steps }'
        };
      }
      const clarifyId = newClarifyId();
      const sig = opts?.abortSignal || signal;
      const waiting = waitClarify({ clarifyId, sessionId, questions, signal: sig });
      if (onEvent) {
        try {
          onEvent({
            type: 'clarify',
            sessionId,
            clarifyId,
            questions,
            ...(plan ? { kind: 'plan', plan } : {})
          });
        } catch {
          /* UI listener must not fail the yield */
        }
      }
      try {
        const answers = await waiting;
        // Preserve the actual UI answer before tool-output projection or compact
        // can shorten it. Questions/plans are context, not user instructions.
        if (answers && typeof answers === 'object' && Object.keys(answers).length) {
          const session = store.get('sessions', sessionId);
          if (session) store.put('sessions', sessionId, {
            ...session,
            userClarifications: [...(session.userClarifications || []), {
              messageId: clarifyId, source: 'clarification', createdAt: Date.now(),
              content: { questions, ...(plan ? { plan } : {}), answers }
            }]
          });
        }
        const classified = plan ? classifyPlanDecision(answers) : { kind: 'unknown', notes: '' };
        if (plan && classified.kind === 'revise' && !classified.notes) {
          unpinFrozenPlan(execution);
          return {
            ok: false,
            approved: false,
            decision: 'revise',
            plan,
            error: 'revise requires notes',
            code: 'BAD_INPUT',
            hint: 'decision=revise needs a non-empty notes string'
          };
        }
        if (plan && classified.kind === 'approved') {
          const pinned = pinFrozenPlan(execution, plan) || plan;
          try {
            ensureSessionAgentsMd(store, sessionId, {
              title: pinned?.title || plan?.title,
              summary: pinned?.summary || plan?.summary
            });
          } catch {
            /* workspace notes must not fail the plan receipt */
          }
          if (wantsDurableTaskFromPlan(answers)) {
            try {
              const cardId = `plan-task_${clarifyId}`;
              // The service must see the task this turn claims, or it never
              // settles and the next message fails with TASK_BUSY.
              if (typeof env.hostTask === 'function') {
                await env.hostTask({ op: 'plan-start', plan: pinned || plan, cardId });
              } else {
                startTaskFromPlanApproval(store, {
                  sessionId,
                  executionId: execution?.executionId,
                  plan: pinned || plan,
                  cardId,
                  now: Date.now()
                });
              }
            } catch {
              /* already-active / card errors must not unwind the plan pin */
            }
          }
          if (pinned && onEvent) {
            try {
              onEvent({ type: 'plan-pinned', sessionId, plan: pinned });
            } catch {
              /* path recorder must not fail the yield */
            }
          }
        } else if (plan) {
          unpinFrozenPlan(execution);
        }
        if (onEvent) {
          try {
            onEvent({
              type: 'clarify-done',
              sessionId,
              clarifyId,
              answers,
              ...(plan
                ? {
                    kind: 'plan',
                    approved: classified.kind === 'approved',
                    decision: classified.kind,
                    ...(classified.kind === 'revise' && classified.notes
                      ? { notes: classified.notes }
                      : {})
                  }
                : {})
            });
          } catch {
            /* ignore */
          }
        }
        if (plan) {
          return {
            ok: true,
            approved: classified.kind === 'approved',
            decision: classified.kind,
            plan,
            ...(classified.kind === 'revise' && classified.notes ? { notes: classified.notes } : {}),
            answers: answers && typeof answers === 'object' ? answers : {}
          };
        }
        return { ok: true, answers: answers && typeof answers === 'object' ? answers : {}, questions };
      } catch (e) {
        const aborted = e?.name === 'AbortError' || sig?.aborted;
        if (onEvent) {
          try {
            onEvent({
              type: 'clarify-done',
              sessionId,
              clarifyId,
              aborted: true,
              ...(plan ? { kind: 'plan' } : {})
            });
          } catch {
            /* ignore */
          }
        }
        if (aborted) throw e;
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };

  const action = {
    name: 'action',
    description:
      'Operate a live Chrome tab (tabId). snapshot reads the page. ' +
      'Clicks, pointer clicks, Enter/Space, and which control to fill or select are op=delegate: pass subgoal and data only. ' +
      'Do not pass a ref or x,y. System1 picks the control and clicks, and types only your data. ' +
      'scroll, wait, upload, listen, and record stay direct. ' +
      'Page policy blocks use run + sys.eval/sys.cdp (inspect view=sys). Errors: {ok:false,code,error,hint}.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['snapshot', 'fill_form', 'click', 'fill', 'select', 'press', 'scroll', 'wait', 'upload', 'pointer', 'listen', 'record', 'choose', 'delegate'],
          description: 'Clicks, pointer clicks, Enter/Space, fill, and select are op=delegate (subgoal + data). A raw click, pointer, fill, select, fill_form, or Enter/Space is rewritten into that assignment; its ref and x,y are ignored. snapshot, scroll, wait, upload, listen, record stay direct. listen=start|stop|clip. record + seconds. no rev on listen/record.'
        },
        tabId: {
          type: 'number',
          description: 'Optional live tab id (world activeTab.tabId). Host does not switch Chrome focus. Omit only when this turn already has activeTab.tabId.'
        },
        ref: {
          type: 'string',
          description: 'Do not pass a ref for click, pointer, fill, select, fill_form, or Enter/Space. System1 chooses the control. scroll and other direct mutates still use the latest snapshot ref.'
        },
        rev: {
          type: 'string',
          description: 'Opaque revision from the latest snapshot or mutate result. Required for ALL mutations, including name/press. Wrong rev → STALE_REF'
        },
        name: {
          type: 'string',
          description: 'Accessible name fallback (label / aria-label / placeholder). Two matches → AMBIGUOUS'
        },
        value: { type: 'string', description: 'The only string System1 may type or select. Copied exactly from you.' },
        fields: {
          type: 'array',
          description: 'fill_form values you allow: [{ name, value }]. System1 chooses the controls. A ref is not the target.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'string' }
            }
          }
        },
        key: {
          type: 'string',
          description: 'Enter and Space activate a control and are performed by System1. Tab, Escape, arrows, and Backspace stay direct and need rev.'
        },
        text: {
          type: 'string',
          description: 'wait: text that must become visible'
        },
        ms: {
          type: 'number',
          description: 'wait timeout cap (default 5000, host-cap 5000). Bare wait without text/ref sleeps this many ms (default 300)'
        },
        path: {
          type: 'string',
          description: 'upload: guest FS path under /scratch (usual), /artifacts, or /context. Exactly one of path, itemId, artifactId.'
        },
        itemId: {
          type: 'string',
          description: 'upload: bound WebItem / 图片N. Host copies bytes to /scratch; does not mutate the item.'
        },
        artifactId: {
          type: 'string',
          description: 'upload: this-session artifact; host resolves primaryPath.'
        },
        method: {
          type: 'string',
          enum: ['auto', 'input', 'drop', 'cdp', 'point'],
          description: 'upload: auto|input|drop|cdp. pointer: point (script elementFromPoint) or cdp (debugger mouse). No silent upgrade between them.'
        },
        x: { type: 'number', description: 'Ignored. System1 chooses a visual click. Do not pass coordinates.' },
        y: { type: 'number', description: 'Ignored. System1 chooses a visual click. Do not pass coordinates.' },
        observe: {
          type: 'string',
          enum: ['controls', 'screenshot', 'both', 'all-frames', 'top', 'none'],
          description: 'Observation mix. New pages already get JPEG + top-frame structure. screenshot|both force a JPEG. all-frames expands snapshot structure to every frame. top keeps structure on the top frame. none skips the auto JPEG.'
        },
        filename: { type: 'string', description: 'upload: override File.name' },
        mimeType: { type: 'string', description: 'upload: override File.type' },
        listen: {
          type: 'string',
          enum: ['start', 'stop', 'clip'],
          description: 'listen: start/stop tab audio, or clip seconds then stop. Default clip.'
        },
        seconds: { type: 'number', description: 'Duration: record defaults to 8s, max 30s; listen=clip defaults to 20s, max 120s' },
        subgoal: { type: 'string', description: 'delegate/choose: the task for System1 (which control to click, or the form to fill). Do not pass a ref.' },
        until: { type: 'string', description: 'delegate/choose: stop when the URL or title contains this, or a control has this exact name' },
        maxSteps: { type: 'number', description: 'delegate step cap, default 6, max 12. A single click assignment defaults to 4.' },
        data: {
          type: 'array',
          description: 'delegate: the only values System1 may type: [{ field, value }]',
          items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } } }
        }
      },
      required: ['op']
    },
    async execute(input = {}) {
      const host = typeof env.hostPageAction === 'function' ? env.hostPageAction : null;
      if (!host) {
        return { ok: false, error: 'no live page host', code: 'NEED_PAGE' };
      }
      const op = String(input.op || '').trim();
      if (!op) {
        return { ok: false, error: 'op is required', code: 'BAD_INPUT' };
      }
      if (op === 'listen' || op === 'record') {
        const result = await executeListenAction(
          {
            store,
            fs,
            sessionId,
            execution,
            signal,
            fetchImpl,
            onEvent,
            settings: env.settings,
            mediaCapabilities: env.mediaCapabilities,
            mediaContext: env.mediaContext,
            audioToWav: env.audioToWav,
            hostPageAction: host,
            listenRuntime: env.listenRuntime,
            sleep: env.sleep,
            activeTab: env.activeTab
          },
          input,
          resolveActionTabId(input, env)
        );
        if (onEvent && result && typeof result === 'object') {
          try {
            onEvent({
              type: 'action-outcome',
              sessionId,
              op,
              ok: result.ok !== false,
              code: result.code ? String(result.code) : undefined,
              tabId: result.tabId ?? env.activeTab?.tabId ?? env.activeTab?.id,
              title: result.title || env.activeTab?.title || ''
            });
          } catch {
            /* UI listener must not fail the tool */
          }
        }
        return result;
      }
      const assignment = plannerClickAssignment(input);
      if (assignment) {
        try {
          const base = {
            sessionId,
            tabId: resolveActionTabId(input, env),
            url: env.activeTab?.url,
            executionId: execution?.executionId
          };
          let ready = assignment;
          if (assignment.resolveRef || assignment.resolveFields) {
            const snap = await host({ ...base, op: 'snapshot', observe: 'none' });
            if (!snap || snap.ok === false) return snap || { ok: false, code: 'NEED_PAGE', error: 'snapshot failed' };
            ready = bindClickAssignmentNames(assignment, snap.controls, input.fields);
          }
          if (ready.error) return { ok: false, code: 'BAD_INPUT', error: ready.error, requestedOp: assignment.requestedOp };
          return await executeDelegateAction({
            subgoal: ready.subgoal,
            until: ready.until,
            data: ready.data,
            maxSteps: ready.maxSteps,
            requestedOp: ready.requestedOp
          }, host);
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            code: typeof e?.code === 'string' ? e.code : 'NEED_PAGE',
            requestedOp: assignment.requestedOp
          };
        }
      }
      try {
        const result = op === 'choose' ? await runOffscreenChoose({
          host,
          base: {
            sessionId,
            tabId: resolveActionTabId(input, env),
            url: env.activeTab?.url,
            executionId: execution?.executionId
          },
          input,
          settings: env.settings,
          fetchImpl,
          onStep: (step) => {
            try {
              onEvent?.({
                type: 'action-outcome',
                sessionId,
                op: 'choose',
                ok: step.verified === true,
                name: step.name || '',
                subgoal: step.subgoal || '',
                ref: step.ref || '',
                via: step.via || '',
                verified: step.verified === true,
                url: step.url || '',
                tabId: resolveActionTabId(input, env),
                title: env.activeTab?.title || ''
              });
            } catch {
              /* UI fact must not fail the tool */
            }
          }
        }) : await host({
          sessionId,
          op,
          ref: input.ref,
          rev: input.rev,
          name: input.name,
          value: input.value,
          fields: input.fields,
          key: input.key,
          text: input.text,
          ms: input.ms,
          path: input.path,
          itemId: input.itemId,
          artifactId: input.artifactId,
          method: input.method,
          filename: input.filename,
          mimeType: input.mimeType,
          x: input.x,
          y: input.y,
          observe: input.observe,
          tabId: resolveActionTabId(input, env),
          url: env.activeTab?.url,
          executionId: execution?.executionId
        });
        if (onEvent && result && typeof result === 'object') {
          try {
            const code = result.code ? String(result.code) : '';
            onEvent({
              type: 'action-outcome',
              sessionId,
              op,
              ok: result.ok !== false,
              code: code || undefined,
              name: input.name ? String(input.name).slice(0, 80) : '',
              tabId: result.tabId ?? env.activeTab?.tabId ?? env.activeTab?.id,
              title: result.title || env.activeTab?.title || ''
            });
            if (code === 'STALE_REF') {
              onEvent({ type: 'stale-ref', sessionId, op, recovered: false, name: input.name || '' });
            } else if (op === 'snapshot' && result.ok !== false) {
              onEvent({ type: 'stale-ref', sessionId, op: 'snapshot', recovered: true });
            }
            if (code === 'TAB_LEASED') {
              onEvent({
                type: 'lease',
                op: 'conflict',
                sessionId,
                code,
                tabId: result.tabId,
                title: result.title,
                holderSessionId: result.holderSessionId
              });
            } else if (result.ok !== false && (result.tabId || env.activeTab?.tabId)) {
              onEvent({
                type: 'lease',
                op: 'acquire',
                sessionId,
                tabId: result.tabId ?? env.activeTab?.tabId ?? env.activeTab?.id,
                title: result.title || env.activeTab?.title || ''
              });
            }
          } catch {
            /* UI fact must not fail the tool */
          }
        }
        if (result && typeof result === 'object') return result;
        return { ok: false, error: 'empty page action result', code: 'NEED_PAGE' };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          code: typeof e?.code === 'string' ? e.code : 'NEED_PAGE'
        };
      }
    },
    toModelOutput: actionToModelOutput
  };

  /**
   * System1 performs the click. The planner supplies subgoal and data.
   * Every dispatched step goes back through host (the gated action path).
   */
  async function executeDelegateAction(input, host) {
    const tabId = resolveActionTabId(input, env);
    const settings = env.settings || {};
    const jev = settings.jev;
    const allowed = jev?.apiKey ? await byokAllowedForProvider('jev', settings.jevProviderId) : true;
    const vision = executorVision(settings);
    const base = { sessionId, tabId, url: env.activeTab?.url, executionId: execution?.executionId };
    const result = await runDelegateLoop({
      subgoal: input.subgoal,
      until: input.until,
      data: input.data,
      maxSteps: input.maxSteps,
      vision,
      tabId,
      signal,
      observe: async ({ screenshot }) => {
        const snap = await host({ ...base, op: 'snapshot', observe: screenshot ? 'screenshot' : 'none' });
        if (!snap || snap.ok === false) return snap || { ok: false, code: 'NEED_PAGE' };
        const file = (Array.isArray(snap.modelParts) ? snap.modelParts : []).find((part) => part?.type === 'file' && part.data);
        return {
          ok: true,
          rev: snap.rev,
          page: snap.page,
          controls: snap.controls,
          canvasCount: snap.canvasCount,
          image: file ? { data: file.data, mediaType: file.mediaType } : null
        };
      },
      decide: async (payload) => {
        if (!jev?.apiKey || !jev?.apiBase) {
          return { ok: false, code: 'NEED_JEV', error: 'No active System1 provider. Add one in Settings. Clicks are not sent without it.' };
        }
        if (!allowed) return { ok: false, code: BYOK_REQUIRES_PLAN, error: BYOK_PLAN_MESSAGE };
        return fetchExecutorStep(jev, payload, { fetchImpl, signal });
      },
      act: (step, snap) =>
        host({
          ...base,
          op: step.op,
          rev: snap.rev,
          ref: step.ref,
          value: step.value,
          key: step.key,
          x: step.x,
          y: step.y,
          method: step.op === 'pointer' ? 'cdp' : undefined,
          observe: 'none'
        }),
      onStep: (row) => {
        try {
          onEvent?.({
            type: 'action-outcome',
            sessionId,
            op: 'delegate',
            ok: row.ok === true,
            code: row.code || undefined,
            name: row.name || '',
            subgoal: String(input.subgoal || '').slice(0, 160),
            ref: row.ref || '',
            via: String(settings.jevProviderName || 'executor').slice(0, 80),
            tabId,
            title: env.activeTab?.title || ''
          });
        } catch {
          /* UI fact must not fail the tool */
        }
      }
    });
    const pending = result.pending;
    const model = { ...result, tabId, requestedOp: input.requestedOp || 'delegate' };
    delete model.pending;
    if (pending?.ref && pending?.rev && result.code === 'DELETE_NEEDS_PLANNER' && assignmentRequestsDelete(input.subgoal)) {
      const gated = await host({
        ...base,
        op: pending.op === 'press' ? 'press' : 'click',
        ref: pending.ref,
        rev: pending.rev,
        name: pending.name || undefined,
        key: pending.key,
        observe: 'none'
      });
      const steps = Array.isArray(model.steps) ? model.steps.slice() : [];
      if (steps.length) {
        const last = { ...steps[steps.length - 1], ok: gated?.ok !== false };
        if (gated?.code) last.code = String(gated.code);
        else delete last.code;
        steps[steps.length - 1] = last;
      }
      const allowed = gated?.ok !== false;
      const out = {
        ...model,
        ok: allowed,
        status: allowed ? 'done' : 'escalated',
        reason: allowed ? 'delete_approved' : 'delete_approval',
        steps,
        hint: allowed
          ? 'System1 chose the delete control and the host approval card allowed the click. Snapshot to verify. Do not repeat it.'
          : 'System1 chose the delete control. The host approval card did not allow the click. Do not pass a ref.'
      };
      if (gated?.code) out.code = String(gated.code);
      else if (allowed) delete out.code;
      if (allowed) delete out.error;
      else out.error = gated?.error || model.error;
      return out;
    }
    return model;
  }

  const office = createOfficeTools({
    store,
    execution,
    fs,
    sessionId,
    signal,
    fetchImpl,
    onEvent,
    hostPageCapture: env.hostPageCapture,
    webAcquire: env.webAcquire,
    activeTab: env.activeTab,
    focusPage: env.focusPage,
    promptId: env.promptId
  });
  const task = createTaskTool({
    store,
    sessionId,
    signal,
    onEvent,
    waitForClarify: waitClarify,
    taskContext: env.taskContext,
    getTaskContext: env.getTaskContext,
    hostTask: env.hostTask,
    taskShouldYield: env.taskShouldYield
  });
  return guardTaskToolExecutions(
    { inspect, acquire, run, clarify, action, task, ...office },
    {
      taskContext: env.taskContext,
      getTaskContext: env.getTaskContext,
      hostTask: env.hostTask,
      taskShouldYield: env.taskShouldYield
    }
  ).tools;
}

/**
 * Bridge Session guest FS to codeRuntime/acquire async FS shape.
 * Maps legacy /output → /artifacts and /work → /scratch.
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} guestFs
 */
export function createCodeFsBridge(guestFs) {
  function mapPath(p) {
    let s = String(p || '').replace(/\\/g, '/');
    if (s.startsWith('/output')) s = '/artifacts' + s.slice('/output'.length);
    if (s.startsWith('/work')) s = '/scratch' + s.slice('/work'.length);
    if (!s.startsWith('/')) s = '/' + s;
    return s;
  }
  return {
    readFile(path, encoding) {
      const g = mapPath(path);
      if (encoding === 'binary' || encoding === null) {
        return guestFs.readFileBytes(g);
      }
      return guestFs.readFile(g);
    },
    writeFile(path, data, opts = {}) {
      const g = mapPath(path);
      // Rehydrate QuickJS / bridge dumps (plain object numeric keys, number[])
      // so binary artifacts are never silently written as empty files.
      const payload =
        typeof data === 'string' ? data : coerceToUint8Array(data);
      const mime =
        opts?.mimeType ||
        (typeof payload === 'string' ? 'text/plain' : guessMimeFromName(g.toLowerCase()));
      if (g.startsWith('/artifacts/')) {
        const policy = htmlWritePolicy(payload, g.split('/').pop() || '');
        if (policy.allow === false) {
          const err = new Error(policy.error || policy.code || 'NEED_HTML_KIND');
          err.code = policy.code || 'NEED_HTML_KIND';
          throw err;
        }
      }
      // Ensure parent
      const parent = g.split('/').slice(0, -1).join('/') || '/';
      try {
        guestFs.mkdirp(parent);
      } catch {
        /* ignore */
      }
      return guestFs.writeFile(g, payload, { mimeType: mime });
    },
    exists(path) {
      return guestFs.exists(mapPath(path));
    },
    readdir(path) {
      return guestFs.list(mapPath(path || '/artifacts'));
    },
    mkdir(path) {
      return guestFs.mkdirp(mapPath(path));
    },
    async stat(path) {
      const g = mapPath(path);
      if (!guestFs.exists(g)) throw new Error(`ENOENT: ${g}`);
      try {
        const bytes = guestFs.readFileBytes(g);
        return { size: bytes.byteLength, isFile: true, isDirectory: false };
      } catch {
        return { size: 0, isFile: false, isDirectory: true };
      }
    }
  };
}

const REMOVED_SCENE_OPS = new Set([
  'html',
  'createScene',
  'fromPage',
  'fromSelection',
  'fromRaster',
  'fromImage',
  'page',
  'raster'
]);
const RUN_OPS = [
  'write_artifact',
  'update_artifact',
  'write_scratch',
  'read',
  'write_package_file',
  'doc',
  'ingestPdf',
  'skill',
  'shelf',
  'createDocument'
];

function isSceneRunInput(input = {}, opEarly = '') {
  return REMOVED_SCENE_OPS.has(String(opEarly || ''));
}

/** Explicit input.tabId wins; else this turn's activeTab. Never retargets Chrome focus. */
function resolveActionTabId(input, env) {
  const fromInput = Number(input?.tabId);
  if (Number.isInteger(fromInput) && fromInput > 0) return fromInput;
  const fromEnv = Number(env?.activeTab?.tabId ?? env?.activeTab?.id);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return undefined;
}

function mapHostToGuest(p) {
  let s = String(p || '');
  if (s.startsWith('/output')) return '/artifacts' + s.slice('/output'.length);
  if (s.startsWith('/work')) return '/scratch' + s.slice('/work'.length);
  if (s.startsWith('/artifacts') || s.startsWith('/scratch') || s.startsWith('/context')) return s;
  // result.path from guest writeFile often already guest path
  if (s.startsWith('/')) return s;
  return null;
}

/**
 * Extract image bytes for multimodal model parts. Fetches on demand into blob:{id}.
 */
async function materializeItemMedia(store, item, includeMedia, opts = {}) {
  if (!includeMedia || !item) return {};
  const src = item.capture?.src || item.capture?.preview?.src || '';
  const isImage = looksLikeImageItem(item);

  let bytes = null;
  let mediaType = 'image/png';

  if (isImage) {
    const ensured = await ensureItemPixels(store, item, opts);
    if (ensured.ok && ensured.bytes?.byteLength) {
      bytes = ensured.bytes;
      mediaType = ensured.mimeType || mediaType;
    }
  }

  if (!bytes) {
    const blob = store.getBlob(`blob:${item.webItemId}`);
    if (blob?.bytes?.byteLength) {
      bytes = blob.bytes;
      mediaType = blob.mimeType || mediaType;
    }
  }

  if (!isImage && !bytes) return {};
  if (!bytes || !bytes.byteLength) {
    return {
      hasImage: Boolean(isImage),
      mediaError: 'image bytes unavailable (only src metadata)',
      mediaType: null,
      modelParts: []
    };
  }

  const base64 = bytesToBase64(bytes);
  const modelParts = [
    {
      type: 'text',
      text: `Image item ${item.webItemId} (${mediaType}, ${bytes.byteLength} bytes)`
    },
    {
      type: 'image',
      image: bytes,
      mediaType
    }
  ];

  return {
    hasImage: true,
    mediaType,
    byteLength: bytes.byteLength,
    /** base64 for transport; tests assert non-empty pixels */
    imageBase64: base64,
    modelParts
  };
}

function stripHeavyCapture(capture = {}) {
  const { dataUrl, bytes, ...rest } = capture;
  if (typeof rest.src === 'string') rest.src = compactSrc(rest.src);
  if (rest.preview && typeof rest.preview.src === 'string') {
    rest.preview = { ...rest.preview, src: compactSrc(rest.preview.src) };
  }
  return rest;
}

/**
 * data: URLs can be megabytes of base64 — as tool-output text they burn tokens
 * without informing the model (pixels travel via multimodal parts instead).
 */
function compactSrc(src) {
  const s = src == null ? '' : String(src);
  if (!s.startsWith('data:')) return s;
  if (s.length <= 96) return s;
  const head = s.slice(0, s.indexOf(',') + 1 || 40).slice(0, 60);
  return `${head}…[data url, ${s.length} chars]`;
}

function summarizeCapture(capture = {}) {
  return {
    tag: capture.preview?.tagName || capture.tag || null,
    textSnippet: String(capture.text || capture.preview?.textSnippet || '').slice(0, 120),
    src: capture.src ? String(capture.src).slice(0, 80) : null,
    kind: capture.kindHint || null
  };
}

function isProbablyText(path, bytes) {
  const lower = String(path).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|pdf|zip|xlsx|pptx|docx)$/i.test(lower)) return false;
  if (/\.(css|js|mjs|ts|json|svg|xml|txt|md)$/i.test(lower)) {
    /* css/js are text for inspect paging even when open-classify has no utf8 kind */
  } else {
    const cls = classifyOpenArtifact({ name: path, bytes });
    if (cls.kind && !isUtf8OpenKind(cls.kind)) return false;
  }
  if (bytes.byteLength === 0) return true;
  let weird = 0;
  const n = Math.min(bytes.byteLength, 512);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return false;
    if (c < 7 || (c > 14 && c < 32 && c !== 9 && c !== 10 && c !== 13)) weird++;
  }
  return weird / n < 0.1;
}

async function hydrateHtmlImageCommands(store, fs, sessionId, commands, opts = {}) {
  return hydrateOfficeImageCommands(store, sessionId, commands, {
    ...opts,
    fs,
    ops: HTML_IMAGE_OPS
  });
}

async function executeSkillOp(input, env = {}) {
  const store = getDurableSkillStore();
  const cmd = Array.isArray(input.commands) && input.commands[0] ? input.commands[0] : input;
  const act = String(cmd.act || cmd.op || input.act || 'upsert').toLowerCase();
  try {
    if (act === 'import') {
      const url = String(cmd.url || input.url || '').trim();
      if (!url) return { ok: false, op: 'skill', error: 'import needs url' };
      const imported = await importSkillFromUrl(url, env);
      if (!imported.ok) return { ok: false, op: 'skill', ...imported };
      const saved = await store.upsert(imported.skill);
      return { ok: true, op: 'skill', act: 'import', skill: publicDurableSkill(saved) };
    }
    if (act === 'delete' || act === 'remove' || act === 'reset') {
      const id = String(cmd.id || input.id || input.name || '').trim();
      if (!id) return { ok: false, op: 'skill', error: 'delete needs id' };
      await store.remove(id);
      return { ok: true, op: 'skill', act, id };
    }
    const rec = String(cmd.markdown || input.markdown || '').trim()
      ? skillRecordFromMarkdown(cmd.id || input.id || cmd.name, cmd.markdown || input.markdown, {
          origin: 'authored',
          name: cmd.name,
          description: cmd.description
        })
      : normalizeDurableSkill({
          id: cmd.id || input.id || cmd.name,
          name: cmd.name || input.name,
          description: cmd.description || input.description,
          instructions: cmd.instructions || input.instructions || input.content || '',
          resources: cmd.resources,
          origin: 'authored'
        });
    const saved = await store.upsert(rec);
    return { ok: true, op: 'skill', act: 'upsert', skill: publicDurableSkill(saved) };
  } catch (e) {
    return { ok: false, op: 'skill', error: e instanceof Error ? e.message : String(e) };
  }
}

function publicDurableSkill(rec) {
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    origin: rec.origin,
    sourceUrl: rec.sourceUrl || '',
    resources: Object.keys(rec.resources || {})
  };
}

export function resolveSkillGuestResource(skillId, resourcePath) {
  const requested = String(skillId || '').trim();
  const id = resolveSkillId(requested);
  const roots = [...new Set([`/scratch/skills/${requested}`, `/scratch/skills/${id}`])];
  const p = String(resourcePath || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  for (const root of roots) {
    if (!p || p === root || p === `${root}/SKILL.md` || p === 'SKILL.md' || p === './SKILL.md') {
      return { kind: 'playbook', path: 'SKILL.md' };
    }
    if (p.startsWith(`${root}/`)) {
      return { kind: 'resource', path: p.slice(root.length + 1) };
    }
  }
  return { kind: 'resource', path: p.replace(/^\.\//, '') };
}

export async function hydrateSkillScriptsIntoGuest(fs) {
  if (!fs || typeof fs.writeFile !== 'function') return;
  for (const s of listPackagedSkillCatalog()) {
    const full = getSkill(s.id);
    if (!full) continue;
    writeSkillPackToGuest(fs, {
      id: s.id,
      instructions: full.instructions,
      resources: full.resources
    });
    for (const alias of skillIdAliases(s.id)) {
      writeSkillPackToGuest(fs, {
        id: alias,
        instructions: full.instructions,
        resources: full.resources
      });
    }
  }
  const durable = await getDurableSkillStore().list();
  for (const rec of durable) {
    if (learnedReuseBlocked(rec)) continue;
    writeSkillPackToGuest(fs, rec);
  }
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Convert tools map to OpenAI tools array shape (for callModel injection).
 * @param {Record<string, {name:string,description:string,parameters:object}>} tools
 */
export function toOpenAiToolsArray(tools) {
  return Object.values(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }));
}

export { isItemBoundToSession };
