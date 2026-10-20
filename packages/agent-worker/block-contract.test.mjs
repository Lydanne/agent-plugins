import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
test('the standalone Worker package discovers and ships its block interface and detail reference',()=>{
  const manifest=JSON.parse(readFileSync(new URL('./openclaw.plugin.json',import.meta.url)));
  const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url)));
  assert.deepEqual(manifest.skills,['./skills']);
  assert(pkg.files.includes('skills'));
  assert(pkg.files.includes('dist/context-blocks.mjs'));
  assert(existsSync(new URL('./skills/agent-worker-context/SKILL.md',import.meta.url)));
  assert(existsSync(new URL('./skills/agent-worker-context/references/completion.md',import.meta.url)));
});
