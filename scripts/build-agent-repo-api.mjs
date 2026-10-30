import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';

// Ship the single API source with each plugin; standalone installs must not
// depend on a private workspace package being published to a registry.
await mkdir('dist',{recursive:true});
await copyFile(new URL('../packages/agent-repo-api/index.mjs',import.meta.url),'dist/agent-repo-api.mjs');
await copyFile(new URL('../packages/agent-repo-api/ui-navigation.mjs',import.meta.url),'dist/ui-navigation.mjs');
await copyFile(new URL('../packages/agent-worker/inspection-transport.mjs',import.meta.url),'dist/inspection-transport.mjs');

await copyFile(new URL('../packages/agent-repo-api/people.mjs',import.meta.url),'dist/people-api.mjs');

await writeFile('dist/entities-api.mjs',(await readFile(new URL('../packages/agent-repo-api/entities.mjs',import.meta.url),'utf8')).replace("from './index.mjs'","from './agent-repo-api.mjs'"));

await copyFile(new URL('../packages/agent-repo-api/context-blocks.mjs',import.meta.url),'dist/context-blocks.mjs');

await copyFile(new URL('../packages/agent-repo-api/maintenance.mjs',import.meta.url),'dist/maintenance-api.mjs');

await writeFile('dist/diagnostics-api.mjs',(await readFile(new URL('../packages/agent-repo-api/diagnostics.mjs',import.meta.url),'utf8')).replace("from './index.mjs'","from './agent-repo-api.mjs'"));

await copyFile(new URL('../packages/agent-worker/timing.mjs',import.meta.url),'dist/worker-timing.mjs');

for(const name of ['workspace-pool.mjs','workspace-lock.mjs'])await copyFile(new URL('../packages/agent-repo-api/'+name,import.meta.url),'dist/'+name);

await copyFile(new URL('../packages/agent-repo-api/worker-source.mjs',import.meta.url),'dist/worker-source-api.mjs');

await copyFile(new URL('../packages/agent-repo-api/plugin-cli.mjs',import.meta.url),'dist/plugin-cli.mjs');

await copyFile(new URL('../packages/agent-repo-api/worker-cli.mjs',import.meta.url),'dist/worker-cli.mjs');
