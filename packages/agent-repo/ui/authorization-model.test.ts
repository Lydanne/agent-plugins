import {describe,it,expect} from 'vitest';
import {defaultCategories,categoryRules,auditSummary,ruleSummary} from './authorization-model';
describe('permission product semantics',()=>{
 it('partitions known writes without conflating atomicity and reversibility',()=>{
  for(const atomicity of ['guaranteed','not-guaranteed','not-applicable'])for(const recovery of ['reversible','irreversible','compensatable','not-applicable']){
   const matches=defaultCategories.filter(c=>Object.entries(c.conditions).every(([k,v])=>v.includes(({access:'write',atomicity,recovery} as Record<string,string>)[k])));
   expect(matches).toHaveLength(1);
  }
  expect(defaultCategories.some(c=>Object.entries(c.conditions).every(([k,v])=>v.includes(({access:'write',atomicity:'unknown',recovery:'unknown'} as Record<string,string>)[k])))).toBe(false);
 });
 it('keeps broad and scoped defaults visible instead of claiming they grant every resource',()=>{
  const rules=[{id:'wide',revision:1,effect:'allow',actions:['read'],selector:{}},{id:'scoped',revision:1,effect:'deny',actions:['update'],selector:{labels:['orders']},conditions:{access:['write'],atomicity:['guaranteed']}}];
  expect(categoryRules(rules,'read').map(r=>r.id)).toEqual(['wide']);
  expect(categoryRules(rules,'atomic').map(r=>r.id)).toEqual(['wide','scoped']);
  expect(ruleSummary(rules[1])).toContain('明确禁止 修改');expect(ruleSummary(rules[1])).toContain('标签 orders');
 });
 it('describes decisions without pretending audit mode actually blocked an invocation',()=>{
  const result=auditSummary({id:'a',revision:1,action:'execution.decision',value:{allowed:false,reason:'EXPLICIT_DENY'}});
  expect(result.result).toBe('策略拒绝');expect(result.reason).toBe('命中明确禁止规则');
 });
});
