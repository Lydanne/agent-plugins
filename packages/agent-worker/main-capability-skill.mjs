import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,dirname,join} from 'node:path';

export async function mainSkillNotice(descriptor,previousRevision,agentId) {
 if(!descriptor)return undefined;
 const {name}=descriptor;let {path}=descriptor;
 let {revision,revisionPath}=descriptor;
 if(descriptor.agentId!==agentId||typeof name!=='string'||!/^openclaw-main-[A-Za-z0-9_-]{1,50}$/.test(name)||
  !/^[a-f0-9]{64}$/.test(revision)||!isAbsolute(path)||!isAbsolute(revisionPath)||revisionPath!==join(dirname(path),'revisions',revision+'.md'))throw Error('Invalid Agent Repo Worker skill descriptor');
 let current=JSON.parse(await readFile(join(dirname(path),'.agent-repo.json'),'utf8'));
 if(current.owner!=='agent-repo'||current.agentId!==agentId||!/^[a-f0-9]{64}$/.test(current.revision))throw Error('Invalid Agent Repo Worker skill ownership');
 if(current.migratedTo){
  if(!isAbsolute(current.migratedTo)||!current.migratedTo.endsWith('/'+name+'/SKILL.md'))throw Error('Invalid global Worker skill migration');
  path=current.migratedTo;current=JSON.parse(await readFile(join(dirname(path),'.agent-repo.json'),'utf8'));
  if(current.owner!=='agent-repo'||current.agentId!==agentId||!/^[a-f0-9]{64}$/.test(current.revision))throw Error('Invalid global Worker skill ownership');
 }
 revision=current.revision;revisionPath=join(dirname(path),'revisions',revision+'.md');
 const body=await readFile(revisionPath,'utf8');
 if(createHash('sha256').update(body).digest('hex')!==revision)throw Error('Agent Repo Worker skill revision mismatch');
 const action=previousRevision===revision?'reuse':previousRevision?'reload':'load';
 return {name,path,revision,revisionPath,action,instruction:'使用 $'+name+'。'+(action==='load'?'开始任务前读取指定版本技能。':action==='reload'?'Main 协作技能已更新，开始任务前重新读取，替代旧协议和插件目录。':'技能版本未变，已读取该版本可复用；未读取或正文不在上下文时先读取。')+'版本正文位于 revisionPath，由 agent-repo 安装和更新，Worker 不修改技能文件。'};
}
