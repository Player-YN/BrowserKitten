---
name: Site Tool Reuse
description: User needs an outcome a live website or already-open logged-in tab already provides — edit, export, generate, convert, upload, send — including how to discover and compare those capabilities with other channels.
---

# When this applies

The result may already exist as an in-page control, an open tab, or a service the user is logged into. This playbook is a discovery method, not a required path.

# Discover

1. Read this turn's world: focusPage / activeTab, and openTabs (tabCount + domains only).
2. Snapshot or screenshot the current page if you need controls or pixels.
3. If a matching domain is already open, you can focus that tab. Opening a parallel editor is optional.
4. Note logged-in services the user named.

# Compare then choose

Write one comparison line before acting:

- Ready-made site tool: what it already does, and the visible success check.
- action (ref / name / pointer), run + sys, or a self-built canvas: what each can do here.

Pick the channel that best fits quality, reliability, and cost for this task. Host codes (NO_TARGET, CDP_BUSY, TAB_NOT_VISIBLE) are facts for switching, not a prescribed order.

# Operate

Use whichever live-tab or guest-sys channel you chose. After a mutate, check the page (url / controls / screenshot if attached).

# Check afterward

Confirm a host-visible postcondition (new filename, canvas object, download, URL change). Tool `ok` is not task success. Upload `siteAccepted` stays unknown — look at the page.

# If the preferred route fails

Re-enter discovery. Try another control, another open domain, another channel, or another logged-in service the user already has. Then compare again. A failed preferred route is not a lock; discovery stays allowed.

# Parameterize

Keep task class, intents, and locate strategies (role, accessible name, region, or viewport-relative pointer). Do not persist `ref`, `rev`, coordinates, or fragile CSS.
