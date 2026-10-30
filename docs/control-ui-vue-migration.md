# Vue Control UI migration and acceptance

All formal AgentRepo and AgentWorker browser entries use Vue 3 Composition API and TypeScript SFCs. The temporary CompatSection and imperative project/log renderers have been removed. Small `.mjs` adapters retain the existing public mount/update/dispose and registration contracts. No production deployment or restart is part of this delivery.

## Feature migration checklist

| Surface | Vue implementation and retained behavior |
| --- | --- |
| Management shell / overview | Seven modules in original order; independent source errors, resource counts, maintenance warnings and Worker summary |
| Projects and compatibility sidebar | Agent/project tabs, repository scopes, metadata, subagents, warnings, project skills, CLI policy maintenance and Worker navigation |
| Workspace / skill maintenance | Lazy reads, draft preservation, revision and request IDs, confirmations, update policies, capacity/occupancy, audit and stale-response isolation |
| Agent-wide Worker tasks | Cross-session summaries, filters, paging, timing, delivery warnings and exact job links; separate data adapter from current-session Worker queries |
| Entities / personnel / standalone entries | Directory/group synchronization, account selection, revision-protected editing, drafts, technical identities and lazy graph relationships |
| Native schedules | Source-bound manager/editor, original permission checks, daily/custom/one-time schedules and delivery confirmation; task history/settings, nested run logs, exact identity checks and truncation notices |
| Audit / recycle | Filters, paging, actor provenance, change comparison, unknown outcomes, retention, revision checks, stable retry IDs and last-page correction |
| Historical/live diagnostics | Live default off; explicit lease acquisition/renewal/release, late-start cleanup, source-specific failures, virtual scrolling, find, grouping, repeats, lazy JSON, exact copy/export and confirmed source-wide clearing |
| Worker sidebar and full task page | Search/filter/paging, four detail views, raw record reader, task timeline, exact task location, single/batch deletion, revision scope and partial/unknown results |

## Shared kit and distribution

`@openclaw-plugins/control-ui-kit` owns host snapshots, per-view theme/portal roots, shadcn-vue source components and reusable interactions. It contains Button, Input, NativeSelect, Select, Checkbox, Switch, Tabs, Badge, Tooltip, Table, Pagination, Card, Skeleton, Empty, Alert, Collapsible, Dialog, AlertDialog, Sheet, Popover and DropdownMenu. Business views own authorization, scope invalidation and server outcome interpretation. No router, Pinia or caching framework was introduced.

Theme variables inherit the host palette; management green and sidebar blue-gray are retained. Tailwind utilities use `ocp:` with no global Preflight. Base rules stay inside plugin roots. The sole native-dialog compatibility exception restores pointer interaction to a host top-layer dialog while a plugin modal owns the body lock. Chromium verifies that dismissing the host dialog leaves the plugin dialog open.

Each plugin independently bundles Vue, components and styles with Vite library mode. `controlUi.entry/styles` refer to a content-hashed directory. `THIRD_PARTY_LICENSES.txt` is generated from the actual Rollup dependency graph alongside each browser entry, including the pinned shadcn-vue source notice. There are no browser CDN imports or runtime dependencies on the other plugin or private kit package.

## Verification and practical limits

Final gates are `pnpm typecheck`, `pnpm build`, isolated `pnpm test` and `pnpm test:ui:e2e`. Existing UI assertions run under Vitest/Vue Test Utils/happy-dom; actual SDK/action ownership and backend tests remain Node tests. UI assertions use behavior, roles and accessible names rather than old renderer identity.

Chromium loads actual built assets and manifests with a synthetic public host. Unsupported actions fail explicitly. Coverage includes 320/400px sidebars, 720px narrow and 1280px desktop, light/dark tokens, scope changes and late responses, in-place host updates, hide/revoke/dispose, independent plugin installs, duplicate mounts and navigation bridge unload. It exercises exact Worker deletion scope, partial failures, stable unknown-result retries, schedule/maintenance/workspace writes, raw records, virtualized 1,500-row logs, real find scrolling, explicit capture and original-Agent late-lease cleanup. Portal bounds, keyboard activation, focus return and native host modal coexistence are browser assertions.

All builds and test artifacts are produced in an isolated checkout. The registered production-loaded checkout is deliberately untouched. These checks are local contract and browser acceptance, not production deployment or real Feishu business end-to-end acceptance.
