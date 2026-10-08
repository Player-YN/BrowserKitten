# Browser Kitten end-to-end eval

Manual tool (like `tests/browser-smoke.cjs`), not part of `node --test` or CI. It launches Chromium with the real
unpacked extension (repo root, or `BROWSERBOT_LOAD_ROOT`), throwaway profile, and drives the product through the same
`workspaceRpc('sendMessage')` path the side panel uses. Success is judged by fixture-server state, never by the
model's own claim.

## Run with a real key (keys only via env, never argv, never written to the report)

```sh
BK_EVAL_API_BASE=https://api.example.com/v1 BK_EVAL_API_KEY=... BK_EVAL_MODEL=model-id \
node tests/eval/run-eval.cjs /path/to/node_modules/playwright-core --tap --repeat 3 --label baseline
```

- Optional System1: `BK_EVAL_JEV_BASE / BK_EVAL_JEV_KEY / BK_EVAL_JEV_MODEL` (saved as a `purpose: 'jev'` provider).
- Credits instead of BYOK (staging): `BK_EVAL_CLOUD_TOKEN` + `BK_EVAL_CLOUD_ORIGIN` (writes the `bk_cloud_*` records via
  `planCloudSignIn`, the account record, and `browserbot_cloud_origin`). Unpacked builds are BYOK-exempt.
- `--tasks id,id` subset, `--repeat N`, `--label name`, `--headed`, `--list`.
- `--flag key=value` (repeatable) writes `chrome.storage.local` keys before the run (value parsed as JSON when it
  parses), so an executor feature flag can be A/B'd: run once with `--flag browserbot_x=true --label on`, once without.
- `--tap` puts a local counting proxy in front of the chat/System1 base: exact HTTP call counts, request/response
  bytes and TTFB. Playwright cannot see the offscreen document's requests, so this is the only way to count them.
  Not available in credits mode.
- `--mock` uses `mock-model.cjs` (no key): a deterministic OpenAI-compatible server with scripted tool calls for
  shop-cheapest, signup-form, survey, cookie-modal and a deliberately dishonest trusted-click. Unscripted tasks
  answer "no script" and must fail, which checks that the harness does not believe the model.

Output: `output/eval/<timestamp>-<label>.json` (all runs) and `.md` (summary table). `output/` is gitignored.

## Tasks (fixtures.cjs, tasks.cjs)

shop-cheapest (search + cheapest to cart), signup-form (validation), date-picker (custom widget, month navigation),
admin-menu (3-level div menu + switch), orders-page3 (paginate, answer text), iframe-form (cross-origin iframe on
`localhost` vs `127.0.0.1`), cookie-modal (banner + modal), trusted-click (`isTrusted` gate), canvas-red (canvas, no
DOM target), long-scroll (code at page bottom), two-tab (`target=_blank` partner page), survey (radio/rating/text).
Prompts mix Chinese and English. Each task has a wall-time budget (`maxMs`); on expiry the run is aborted via
`abortCurrentExecution` and scored as a failure.

## How it works

- Provider: `llm.saveProvidersState` from an extension page (`src/sidepanel.html`, the only page role the RPC accepts).
- Settle detection: the `sendMessage` RPC resolves only when the execution settles (answer, error, abort). The runner
  also auto-answers `clarify`/plan prompts (nobody is present, counted in `clarifications`) and polls the wall budget.
- Events: an `onMessage` listener in the control page records the `session_workspace_event` broadcasts.

## Metrics: exact vs approximate

Exact: success (fixture state), wall time (page clock, send to settle), main-model calls (`model-end` events), tool
calls and action ops, tool errors and codes, per-step prompt/completion/cached tokens when the provider returns usage
(`tokenSource: api-per-step`), HTTP calls/bytes/TTFB and System1 calls with `--tap` or `--mock`.
Approximate: tokens when only turn totals exist (`tokenSource: turn-total:*`, may be an estimate); without `--tap`,
System1 calls are not counted (0); cached tokens are 0 for providers that do not report them. Cost is not computed
(no price table); multiply the token columns by your own rates.

## Findings from building this (against main @ 801ae48)

1. Ref-only mutations fail with `APPROVAL_MISMATCH` ("Ticket payload hash does not match"). The offscreen computes the
   dispatch hash from its snapshot cache with an empty control name (`lookupControl` reads the service worker's
   in-memory map, which is empty in the offscreen), the service worker recomputes it with the real control name. It
   only works when the model also passes `name` (or `fields[].name`). The mock scripts do that on purpose; set
   `BK_MOCK_REF_ONLY=1` to reproduce the failure.
2. `actionAccessibleName` prefers `resolveNearbyLabel` over a button's own text, so un-labelled buttons get named after
   nearby text ("Subscribe to newsletter" is reported as "Get the best stories in your inbox.", a submit button as
   "Comments"). The mock scripts match on those names.
3. Plain `div` menus/widgets without role, tabindex or aria are not controls (`admin-menu` snapshot has 0 controls),
   so they need the visual pointer path.
