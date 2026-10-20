import { defaultProfileRoles } from "./business-config.js";
import type { FeishuConfig } from "./types.js";
import { renderSection } from "./context-sections.js";
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ReplyRole = string;
export type ReplyDetail = string;
type Preferences = { role?: ReplyRole; detail?: ReplyDetail; updatedAt: string; source: 'self' };
export type ColleagueInput = {
  accountId: string; appId?: string; senderOpenId: string; name?: string;
  jobTitle?: string; jobTitleStatus?: "available"|"empty"|"unavailable"; departments?: {id:string;name?:string;code?:number}[]; departmentIds?: string[]; text: string;
};
export class ColleagueProfiles {
  constructor(readonly path: string, readonly config: NonNullable<FeishuConfig["colleagueProfile"]> = {}) {}
  context(input: ColleagueInput, {readOnly = false}: {readOnly?: boolean} = {}): string {
    const profile = this.snapshot(input, {readOnly});
    return profile ? '\n\n' + renderSection('ParticipantProfile', JSON.stringify(profile)) + (this.config.guidance ? '\n' + renderSection('ParticipantGuidance', this.config.guidance) : '') : '';
  }
  snapshot(input: ColleagueInput, {readOnly = false}: {readOnly?: boolean} = {}) {
    if (!input.senderOpenId || this.config.enabled === false) return undefined;
    const text=input.text.trim();
    const roles=this.config.roles ?? defaultProfileRoles;
    const commands={view:'查看我的画像',remove:'删除我的画像',rolePrefix:'设置我的角色',detailPrefix:'设置我的回复偏好',...this.config.commands};
    const commandValue=(prefix:string) => !readOnly && prefix && text.startsWith(prefix) && /^[：:\s]+/.test(text.slice(prefix.length)) ? text.slice(prefix.length).replace(/^[：:\s]+/, '') : undefined;
    mkdirSync(dirname(this.path), {recursive:true, mode:0o700});
    const db = new DatabaseSync(this.path);
    chmodSync(this.path,0o600);
    try {
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS colleague_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const key=JSON.stringify([input.accountId,input.appId??'',input.senderOpenId]);
      db.exec('BEGIN IMMEDIATE');
      const row=db.prepare('SELECT value FROM colleague_preferences WHERE key=?').get(key) as {value:string}|undefined;
      let preferences: Preferences|undefined=row?JSON.parse(row.value):undefined;
      let operation='none';
      if(!readOnly && commands.remove && text===commands.remove) {
        db.prepare('DELETE FROM colleague_preferences WHERE key=?').run(key);
        preferences=undefined; operation='deleted';
      } else {
        const roleValue=commandValue(commands.rolePrefix);
        const role=roles.some(r=>r.name===roleValue)?roleValue:undefined;
        const detailValue=commandValue(commands.detailPrefix);
        const detail=(this.config.detailOptions ?? ['简洁','详细','自动']).includes(detailValue ?? '')?detailValue:undefined;
        if(role||detail) {
          preferences={...preferences,...(role?{role}:{}),...(detail?{detail}:{}),source:'self',updatedAt:new Date().toISOString()};
          db.prepare('INSERT OR REPLACE INTO colleague_preferences (key,value) VALUES (?,?)').run(key,JSON.stringify(preferences));
          operation='updated';
        } else if(!readOnly && commands.view && text===commands.view) operation='view';
      }
      db.exec('COMMIT');
      const titles=input.jobTitle??'';
      const candidates: ReplyRole[]=[];
      for(const item of roles)if(item.titleKeywords.some(word=>titles.toLocaleLowerCase().includes(word.toLocaleLowerCase())))candidates.push(item.name);
      const inferred=candidates.length===1?candidates[0]:undefined;
      const role=preferences?.role??inferred;
      return {
        senderOpenId:input.senderOpenId,name:input.name??null,
        directory:{jobTitle:input.jobTitle??null,jobTitleStatus:input.jobTitleStatus??(input.jobTitle?"available":"unavailable"),departments:[...(input.departments??[]),...(input.departmentIds??[]).filter(id=>!input.departments?.some(d=>d.id===id)).map(id=>({id}))],source:'feishu_contact'},
        preferences:preferences??null,profileOperation:operation,
        audience:role??'未知',audienceSource:preferences?.role?'self':inferred?'job_title_inference':'unknown',
      };
    } finally {db.close();}
  }
}
