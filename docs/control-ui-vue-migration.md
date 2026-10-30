# Vue Control UI migration status

This tracks the complete accepted migration, not a reduced completion target. Work is in progress. Production is not deployed.

## Converted to Vue SFCs

- AgentRepo management shell and module navigation, preserving the content region and focus.
- Overview, independent source errors, resource counts, maintenance warnings and Worker summary.
- Agent-wide Worker task table, filters, pagination, timing, notification warnings and exact task links.
- Audit filters, paging, actor provenance, before/after differences and unknown outcomes.
- Recycle dialog, stable request IDs, revision checks, retention confirmation, last-page correction and readonly behavior.

The temporary `CompatSection.vue` boundary is still used by the remaining management modules. It must be deleted after those views migrate. The old project sidebar remains imperative; wrapping it is not considered completed migration.

## Still required for full completion

- Worker sidebar and full task page: conversation list, four detail views, original-record reader, tool rendering, exact-scope single/batch deletion.
- Entities and personnel, including sync/account selection, revision-protected editing, drafts, technical identities, lazy graph relationships and standalone compatibility entries.
- Projects, skills/CLI maintenance, workspace configuration, subagent definitions and the project sidebar.
- Schedules, native/system task history, settings, audit and existing confirmation/admission semantics.
- Historical/live diagnostics including explicit lease acquisition, release, virtualized logs, search, export and partial-source failures.
- Complete the shared shadcn-vue controls; migrate UI tests to Vitest; remove temporary bridges and obsolete renderers/styles.
- Expand real Chromium acceptance to every migrated surface and operation, independent installs and cross-plugin lifecycle.

## Verification

`pnpm typecheck`, `pnpm build`, isolated `pnpm test`, and `pnpm test:ui:e2e` are the final gates. Run builds/tests from the isolated checkout because the registered source directory is production-loaded. Do not pull new UI manifests into that live checkout or restart production without deployment authorization.

The Chromium harness serves actual built JS/CSS and manifests from the isolated checkout, with a synthetic implementation of the public host contract. Unsupported actions fail explicitly. It does not use production config, sessions, tokens or databases. The initial suite covers audit and recycle at 320/400/720/1280px, host themes, portal bounds, keyboard focus, unknown write retries, permission loss, cleanup and the Agent-wide Worker task link/draft.

The browser run exposed and fixed a `process.env.NODE_ENV` library-build reference and the need to serialize Vue proxy payloads at the RPC boundary. Host snapshots bind methods to their original receiver.
