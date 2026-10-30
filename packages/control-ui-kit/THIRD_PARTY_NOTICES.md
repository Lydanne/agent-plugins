# Third-party components

Button sources: unovue/shadcn-vue, MIT, revision `4d6963aa8a482be7609cb05d3f8b7fe42082b634`, `apps/v4/registry/new-york-v4/ui/button`. Local changes: utility prefix, local cn import, and removal of independent system-dark variants (host theme tokens are authoritative). See LICENSE.shadcn-vue.

Runtime dependencies: Vue (MIT), Reka UI (MIT), class-variance-authority (Apache-2.0), clsx (MIT), tailwind-merge (MIT). Versions are recorded in the workspace lockfile. These must remain covered by the final plugin distribution notices when browser entries adopt this kit.

Dialog uses the shadcn-vue Dialog component structure and Reka primitives, adapted to the injected per-view portal and host visibility.
