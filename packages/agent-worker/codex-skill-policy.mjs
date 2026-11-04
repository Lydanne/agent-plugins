// Automatic catalogs are owned by Worker. These switches do not restrict file
// reads, native execution, global instructions or content already in a session.
export const codexSkillConfig=Object.freeze({
 'features.skip_host_skill_discovery':true,
 'skills.include_instructions':false,
 'skills.bundled.enabled':false,
});
export const codexSkillArgs=Object.freeze(Object.entries(codexSkillConfig).flatMap(([key,value])=>['-c',key+'='+value]));

// Reject template overrides instead of depending on CLI merge/argument order.
export function assertCodexSkillArgs(args){
 assertCodexOwnedConfig(args,codexSkillConfig,'skill',['skills','features','skills.bundled']);
}
export function assertCodexOwnedConfig(args,policy,label,parents){
 const seen=new Set();
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  for(const [key,value] of Object.entries(policy))if(key.startsWith('features.')){
   const flag=value?'--disable':'--enable',feature=key.slice(9);
   if(arg===flag&&args[i+1]===feature||arg===flag+'='+feature)throw Error('Hermes '+label+' policy conflict');
  }
  const assignment=arg==='-c'||arg==='--config'?args[++i]:arg.startsWith('--config=')?arg.slice(9):arg.startsWith('-c')&&arg.length>2?arg.slice(2):undefined;
  if(typeof assignment!=='string')continue;
  const equal=assignment.indexOf('=');if(equal<0)continue;
  if(assignment.slice(0,equal).includes('\\'))throw Error('Hermes '+label+' policy conflict');
  const key=assignment.slice(0,equal).replace(/[\s"']/g,'');
  if(parents.includes(key))throw Error('Hermes '+label+' policy conflict');
  if(Object.hasOwn(policy,key)){
   if(seen.has(key)||assignment.slice(equal+1).trim()!==String(policy[key]))throw Error('Hermes '+label+' policy conflict');
   seen.add(key);
  }
 }
 if(seen.size!==Object.keys(policy).length)throw Error('Hermes '+label+' policy missing');
}
