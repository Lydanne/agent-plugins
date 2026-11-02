import {mkdir,readFile,open,rename,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {acquireLock} from './workspace-lock.mjs';

const transitions = {
  saving: new Set(['saved','recovery_required']),
  saved: new Set(['releasing']),
  releasing: new Set(['parked','recovery_required']),
  parked: new Set(['restoring']),
  restoring: new Set(['restored','recovery_required']),
  recovery_required: new Set(['saving','restoring']),
  restored: new Set(),
};
const bindingKeys = ['agentId','projectId','jobId','assignmentId','workspaceId','workspacePath','checkpointId'];
function identity(binding) {
  binding = {...binding,checkpointId:binding?.checkpointId??'initial'};
  if (!binding || bindingKeys.some(key => typeof binding[key] !== 'string' || !binding[key])) throw Error('Invalid checkpoint identity');
  return Object.fromEntries(bindingKeys.map(key => [key,binding[key]]));
}
async function directory(root) {
  root = await realpath(root);
  const path = join(root,'workspace-checkpoints');
  await mkdir(path,{mode:0o700,recursive:true});
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw Error('Checkpoint directory must not be linked');
  return path;
}
async function location(root,binding) {
  const id = identity(binding), dir = await directory(root);
  const key = createHash('sha256').update(JSON.stringify(id)).digest('hex');
  return {id,dir,file:join(dir,key+'.json'),lock:join(dir,key+'.lock')};
}
async function read(file) {
  if ((await lstat(file)).isSymbolicLink()) throw Error('Checkpoint record must not be linked');
  return JSON.parse(await readFile(file,'utf8'));
}
function validate(record,id) {
  if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !Object.hasOwn(transitions,record.status) || bindingKeys.some(key => record.binding?.[key] !== id[key]) ||
      !Array.isArray(record.repositories)) throw Error('Invalid checkpoint record');
  return record;
}
async function persist(file,record) {
  const temporary = file+'.'+randomUUID();
  const handle = await open(temporary,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(record,null,2)+'\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary,file);
}
export async function readCheckpoint(root,binding) {
  const {id,file} = await location(root,binding);
  return validate(await read(file),id);
}
// Call before mutating Git. Saving/restoring operations persist their per-repository
// receipts through revision-checked updates, so incomplete work never looks saved.
export async function createCheckpoint(root,binding) {
  const {id,file,lock} = await location(root,binding), release = await acquireLock(lock);
  try {
    try { return validate(await read(file),id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = {version:1,revision:1,binding:id,status:'saving',repositories:[],createdAt:Date.now()};
    await persist(file,record); return record;
  } finally { release(); }
}
export async function updateCheckpoint(root,binding,expectedRevision,{status,repositories}) {
  const {id,file,lock} = await location(root,binding), release = await acquireLock(lock);
  try {
    const current = validate(await read(file),id);
    if (current.revision !== expectedRevision) throw Error('Checkpoint revision changed');
    if (status !== current.status && !transitions[current.status].has(status)) throw Error('Invalid checkpoint transition');
    if (!Array.isArray(repositories)) throw Error('Checkpoint repository receipts are required');
    const record = {...current,status,repositories:structuredClone(repositories),revision:current.revision+1,updatedAt:Date.now()};
    await persist(file,record); return record;
  } finally { release(); }
}
