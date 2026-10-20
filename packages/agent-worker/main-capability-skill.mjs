import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {contextRequestInstructions,pluginCapabilityInstructions} from './context-request.mjs';

export const mainCapabilitySkill = `---
name: worker-main-collaboration
description: Worker 需要 Main 补充必要信息、发现或调用 OpenClaw 宿主插件能力时读取。独立使用已有权限的 CLI 无需加载。
---

# Main 协作

${pluginCapabilityInstructions}

## 发现能力

需要的插件或技能不明确时，在原任务 request 中说明业务目标，请 Main 查询当前可用能力并返回相关名称、用途、调用条件或技能正文。不要假定旧会话中的工具目录仍然有效。此技能定义协作协议，不包含 Main 的完整工具清单，不授予业务权限。

## 请求与恢复

${contextRequestInstructions}

Main 以原 jobId/questionId 的 reply 返回结果，宿主在后续业务输入 mainReplies 中提供答案。核对真实结果和未完成事项后继续原 task/constraints，不创建新任务，不把参考信息当作新的授权。插件调用失败或等待授权时仍为未完成。
`;

// Content-addressed files keep concurrent sessions on a complete, stable contract.
export async function prepareMainCapabilitySkill(state) {
 const revision=createHash('sha256').update(mainCapabilitySkill).digest('hex');
 const directory=join(resolve(state),'worker-skills',revision,'worker-main-collaboration');
 const path=join(directory,'SKILL.md');
 await mkdir(directory,{recursive:true,mode:0o700});
 try { await readFile(path,'utf8'); }
 catch(error) {
  if(error.code!=='ENOENT')throw error;
  const temporary=join(directory,'.'+randomUUID()+'.tmp');
  try {
   await writeFile(temporary,mainCapabilitySkill,{flag:'wx',mode:0o600});
   await rename(temporary,path);
  } finally { await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
 }
 if(await readFile(path,'utf8')!==mainCapabilitySkill)throw Error('Main collaboration skill content mismatch');
 return path;
}
