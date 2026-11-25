# Changelog

All notable changes to this project are documented here.

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