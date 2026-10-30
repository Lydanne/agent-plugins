# Third-party components

Button sources: unovue/shadcn-vue, MIT, revision `4d6963aa8a482be7609cb05d3f8b7fe42082b634`, `apps/v4/registry/new-york-v4/ui/button`. Local changes: utility prefix, local cn import, and removal of independent system-dark variants (host theme tokens are authoritative). See LICENSE.shadcn-vue.

Runtime dependencies: VueUse (MIT), Vue (MIT), Reka UI (MIT), class-variance-authority (Apache-2.0), clsx (MIT), tailwind-merge (MIT). Versions are recorded in the workspace lockfile. These must remain covered by the final plugin distribution notices when browser entries adopt this kit.

Dialog uses the shadcn-vue Dialog component structure and Reka primitives, adapted to the injected per-view portal and host visibility.

ActionMenu and Tabs are local compositions of Reka UI primitives following the shadcn-vue component pattern, adapted for namespaced styles and per-view portal targets. Button defaults to type=button to avoid accidental form submission.

Input, Badge and NativeSelect sources: the same shadcn-vue revision, under `apps/v4/registry/new-york-v4/ui/{input,badge,native-select}` (MIT). Local changes: utility prefix, host-driven dark theme, local cn import, and a local inline chevron and typed event tuple for NativeSelect.

Popover is a local Reka composition following the shadcn-vue pattern, with an explicit instance portal, collision handling and host lifecycle cleanup.

Checkbox, Switch, Tooltip, Table, Pagination, Card, Skeleton, Empty, Alert, Collapsible, AlertDialog, Sheet, Select and DropdownMenu sources: the same pinned shadcn-vue revision, under the corresponding `apps/v4/registry/new-york-v4/ui` directories (MIT). Local adaptations namespace utility classes, inherit the host theme, use local utility imports and geometric icon replacements, and direct portals to the current view's overlay root. Table forwards accessibility attributes to the table element. Raw primitives require their owning feature to manage controlled state and lifecycle.

Each plugin build generates THIRD_PARTY_LICENSES.txt from the packages present in the actual bundled module graph, including their complete license and notice files.
