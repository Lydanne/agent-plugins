# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace maintains independent OpenClaw plugins under `packages/`:

- `feishu/`: TypeScript entrypoints, implementation and colocated tests in `src/`, bundled business `skills/`, and `assets/`.
- `agent-worker/`: JavaScript ESM plugin in `index.mjs`, with `prompt.test.mjs`.
- `scripts/`: shared build and isolated-test runners.
- `.agents/skills/`: contributor workflows, separate from shipped plugin skills.

Preserve upstream licenses and record upstream versions and local deviations in `UPSTREAM.md`.

## Build, Test, and Development Commands

Use Node.js 24.19+ and pnpm 10.33.2. Run from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test
```

Installation preserves the lockfile. Build bundles Feishu into `dist/`, regenerates its manifest schema, and syntax-checks agent-worker. Test runs each package’s configured suite. Run typecheck, build, and test after changes; inspect generated manifest differences.

There is no standalone development server. Runtime checks require an isolated OpenClaw installation; do not restart or replace production plugins without explicit authorization.

## Coding Style & Naming Conventions

Use TypeScript for Feishu and ESM `.mjs` for agent-worker. Follow surrounding formatting: two-space indentation, semicolons, and existing quote style. Prefer kebab-case module filenames, camelCase functions, and PascalCase types. No repository-wide formatter or lint command is configured; avoid unrelated reformatting.

Integrate with the host only through public `openclaw/plugin-sdk` subpaths, never sibling source trees or internal modules.

## Testing Guidelines

Feishu uses Vitest with colocated `*.test.ts`; agent-worker uses Node’s test runner with `*.test.mjs`. Add regression coverage for changed behavior. No numeric coverage threshold is configured.

Use temporary `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` for tests; the Feishu runner creates these automatically. Never read real runtime state or send Feishu messages. The selected suite excludes unmigrated upstream tests. The strict typecheck covers production TypeScript and SDK type fixtures. Maintain precise compatibility declarations only for missing public SDK types; never mask them with untyped module declarations or private host imports. Report unverified platform behavior; passing local checks is not production validation.

## Git Workflow

Work directly on `main`; this repository does not use PRs or routine topic branches. Before editing, inspect the worktree and run `git pull --ff-only origin main` on `main`. Preserve unrelated changes and existing worktrees; never discard or automatically stash them to switch branches or pull.

After validation, stage only task-related files, commit using Conventional Commits (e.g. `fix(feishu): handle duplicate messages`), then run `git push origin main`. Inspect all outgoing commits before pushing and verify the remote SHA afterward. Do not force-push or rewrite history. If histories diverge, inspect both sides and resolve without overwriting work; report unresolved conflicts.

Never commit credentials, environment configuration, SQLite state, or business data.

## Agent Workflows

Communicate in Chinese. Use `.agents/skills/openclaw-plugin-develop/SKILL.md` and `.agents/skills/openclaw-plugin-commit/SKILL.md`. Pull, commit, and push on `main` are standing authorization after each completed and validated change; no repeated confirmation is needed. Honor explicit requests to skip commit or push. Do not create PRs. Production changes still require explicit authorization.
