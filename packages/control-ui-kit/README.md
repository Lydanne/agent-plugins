# Control UI migration infrastructure

Vue 3 + TypeScript + shadcn-vue. Not connected to production browser entrypoints yet; existing pages still use their existing renderers. Overall migration is in progress.

`mountVueView(Component)` adapts the public mount/update/dispose contract. Inject host snapshots with `useHostContext()` and the per-view portal target with `useOverlayTarget()`. Feature components must invalidate requests on target/permission changes and release timers and diagnostic leases when hidden; these remain domain responsibilities.

Import `theme.css` from each browser entry. Utilities use the `ocp:` prefix, without global Preflight. `buildControlUi({root,entry})` creates standalone content-hashed ESM/CSS and updates the manifest; build in an isolated checkout if production loads the source directory. Button provenance and license are in THIRD_PARTY_NOTICES.md.

Remaining: complete components/lifecycle utilities; migrate Worker list, details, reader and deletion; migrate all seven AgentRepo modules and compatibility entries; migrate UI tests; add Chromium responsive/theme/portal acceptance; remove old renderers. No production entry switch, deployment or restart has occurred.
