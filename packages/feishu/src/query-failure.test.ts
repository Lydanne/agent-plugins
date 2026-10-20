import {afterEach, expect,it} from 'vitest';
import {explainCodexQueryWarning} from './query-failure.js';
const globals=globalThis as unknown as Record<symbol,unknown>;
const symbol=Symbol.for('ada.codex-query-diagnostics.v1');
afterEach(()=>{delete globals[symbol];});
it('uses only fresh same-account/session/requester job diagnostics',()=>{
 globals[symbol]=new Map([[JSON.stringify(['a','s','u']),{updatedAt:Date.now(),read:()=> '原后台任务仍在执行，请继续查询。'}]]);
 const context={accountId:'a',sessionKey:'s',requesterId:'u'};
 expect(explainCodexQueryWarning('⚠️ Codex Query failed',context)).toContain('仍在执行');
 for(const other of [{since:Date.now()+1000},{accountId:'b'},{sessionKey:'other'},{requesterId:'other'}])expect(explainCodexQueryWarning('⚠️ Codex Query failed',{...context,...other})).toContain('没有提供');
 (globals[symbol] as Map<string,unknown>).set(JSON.stringify(['a','s','u']),{updatedAt:Date.now()-600001,read:()=> 'stale'});
 expect(explainCodexQueryWarning('⚠️ Codex Query failed',context)).toContain('没有提供');
});
it('does not rewrite ordinary prose or claim a reason if lookup fails',()=>{
 const context={accountId:'a',sessionKey:'s',requesterId:'u'};
 expect(explainCodexQueryWarning('用户说 Codex Query failed',context)).toBe('用户说 Codex Query failed');
 globals[symbol]=new Map([[JSON.stringify(['a','s','u']),{updatedAt:Date.now(),read:()=>{throw Error('private');}}]]);
 expect(explainCodexQueryWarning('⚠️ Codex Query failed',context)).not.toContain('private');
});
