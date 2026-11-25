# Changelog

All notable changes to this project are documented here.

## 0.2.0

**Typed references (breaking)**
- The free-text shared body and the reference-entry list are one typed list now:
  `project.references[]` holds `link` entries (a path or URL the Host re-checks, marks stale
  and cards can point at) and `note` entries (convention text that is never probed)
- Old documents migrate on read: `project.shared` becomes a `note` named 项目说明 at the top,
  `project.sharedEntries` becomes `link` entries that keep their ids, so card `refs` keep working
- Tools: `greenlight_shared_set` and `greenlight_shared_entry` are replaced by
  `greenlight_reference` (list / add / update / remove); the tool count drops from 15 to 14
- The Host still accepts the old operation names (`project.setShared`, `sharedEntry.*`) so an
  older client does not break mid-upgrade

**Board**
- The panel is called 绿灯看板 / Greenlight Board, with a traffic-light mark whose green lamp is lit
- The project rail collapses from a single icon beside the title; collapsed it renders nothing at
  all, the content takes the full width, and the state is remembered per browser

**Fixes**
- A batch that patched deliverables and submitted in one request probed against the document from
  before the patch, so the deliverables looked unverifiable (probes now follow batch order)
- Whole-document imports and replacements park the previous file first
  (`board.json.backup-<stamp>-before-replace`, newest ten kept)
- Restoring archived cards rebuilt a project without its `references`
- Socket integration tests skip instead of failing on hosts that deny loopback TCP

## 0.1.0

First public release.

**Acceptance engine**
- Automatic acceptance: a card closes itself when its evidence, claims and deliverables check out;
  anything unverifiable escalates to a human with a concrete reason
- Real deliverable verification against the filesystem: relative paths resolve against the project
  root, directories and empty files count as missing, an unset root escalates instead of guessing
- Verification layers (`static` / `unit` / `build` / `host` / `device`) with per-project
  `requiredLayers`, so "it compiled" never looks like "it ran on the device"
- Per-card claims `{ what, how, layer, outcome }`; a passing claim must say how it was checked
- Configurable rules: require evidence, require deliverables, verify deliverables, require a Session,
  require a verified claim
- Verification debt: unverified items stay visible instead of silently disappearing
- Acceptance verdicts split blockers from warnings, so small gaps do not escalate whole cards
- Column gates can require evidence or deliverables before a card enters review

**Board**
- Projects → subtasks; each subtask can own a main Session and be dispatched with one click
- Per-project shared notes, reference entries and memory; references are re-probed and flagged stale
- Decision anchor: requirement digest, key decisions, open risks, deviations
- Per-card next action, reused as the opening line of a dispatch prompt
- Card history (moves, acceptances, escalations, claims, reviews) and independent review records
- `greenlight_preview` dry-runs operations without writing anything
- Six columns with drag and drop, search and filters, priority, due date, tags, templates
- 8-second undo, 7-day trash, and confirmation for every delete, archive, import and purge
- Cold-storage archive in a separate file, restorable at any time
- Chinese and English UI, SSE live updates, JSON import/export
- 15 `greenlight_*` tools for agents

**Storage**
- Atomic writes: temp file, `fsync`, read-back comparison, rename
- Corrupt documents are preserved as a backup instead of being overwritten
- Serialized mutations with revision checks, so concurrent writes cannot lose updates

**Tests**
- 93 host tests and 259 client render checks