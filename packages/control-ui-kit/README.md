# Shared Vue Control UI kit

Vue 3 + TypeScript + locally maintained shadcn-vue sources, used by every formal AgentRepo and AgentWorker UI entry. Source provenance and adaptations are in THIRD_PARTY_NOTICES.md and LICENSE.shadcn-vue.

Load each entry in the same document window as its mounting container. Reka focus guards and scroll locks are realm-local; foreign-document containers are rejected before allocating roots, subscribing, or issuing RPCs. ShadowRoot containers in the same document are supported.

`mountVueView(Component)` adapts the public mount/update/dispose contract. Inject reactive host snapshots with `useHostContext()` and the per-view portal root with `useOverlayTarget()`. Feature components invalidate requests on target/permission changes and release timers and diagnostic leases when hidden. Raw Reka/shadcn primitives require controlled business state; the shared Dialog, Popover and ActionMenu additionally handle host visibility and scope changes.

Import `theme.css` once from each browser entry. Utilities use `ocp:` without global Preflight. Independent Vue bundles use a shared per-view ID sequence to avoid accessibility ID collisions. Every portal explicitly targets its view's themed overlay root.

`buildControlUi({root,entry})` builds a self-contained content-hashed ESM/CSS directory, emits complete THIRD_PARTY_LICENSES.txt from the actual bundled dependency graph, and updates the public manifest entry/styles. No CDN or cross-plugin runtime dependency is required. Build in an isolated checkout when production loads source directly. See ../../docs/control-ui-vue-migration.md for the feature checklist and acceptance boundary.
