# Control UI migration infrastructure

Vue 3 + TypeScript + shadcn-vue. The AgentRepo browser entry now uses this kit for the management shell, overview, Agent-wide Worker task management, audit and recycle views. Other features are still migrating. Production has not been deployed.

`mountVueView(Component)` adapts the public mount/update/dispose contract. Inject host snapshots with `useHostContext()` and the per-view portal target with `useOverlayTarget()`. Feature components must invalidate requests on target/permission changes and release timers and diagnostic leases when hidden; these remain domain responsibilities.

Import `theme.css` from each browser entry. Utilities use the `ocp:` prefix, without global Preflight. `buildControlUi({root,entry})` creates standalone content-hashed ESM/CSS and updates the manifest; build in an isolated checkout if production loads the source directory. Button provenance and license are in THIRD_PARTY_NOTICES.md.

Remaining: complete components/lifecycle utilities; migrate Worker list, details, reader and deletion; migrate remaining AgentRepo project/skill/workspace, entities/personnel, schedule and log modules and compatibility entries; finish UI test migration and expand Chromium coverage; remove old renderers. No production entry switch, deployment or restart has occurred.
