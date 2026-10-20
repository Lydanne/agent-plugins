import {describe,it,expect,vi,afterEach} from "vitest";
import {TaskProgress,registerTaskProgress,registerAdaTaskProgressTool} from "./task-progress.js";
afterEach(()=>vi.useRealTimers());
describe("public progress snapshots",()=>{
  it("does not invent completed work or ETA from raw tool activity",()=>{
    const p=new TaskProgress();p.toolStarted("codex_query",{action:"wait",secret:"never-show-this"});
    expect(p.render()).toContain("尚无可确认");expect(p.render()).toContain("等待后台任务");
    expect(p.render()).toContain("暂时无法可靠估计");expect(p.render()).not.toContain("never-show-this");
  });
  it("reflects actual plan status without treating all steps as completed",()=>{
    const p=new TaskProgress();p.plan([{step:"已核对目标",status:"completed"},{step:"读取任务状态",status:"in_progress"},{step:"核验文件",status:"pending"}]);
    expect(p.render()).toContain("已完成：已核对目标");expect(p.render()).toContain("正在做：读取任务状态");expect(p.render()).toContain("还需要：核验文件");
  });
  it("expires estimates and labels stale milestones",()=>{
    vi.useFakeTimers();vi.setSystemTime(0);const p=new TaskProgress();
    p.update({completed:["任务已受理"],current:"等待生成",remaining:["核验"],estimate:{minMinutes:2,maxMinutes:4,basis:"服务返回预计四分钟内完成"}});
    expect(p.render()).toContain("2–4 分钟");
    vi.setSystemTime(300_000);expect(p.render()).toContain("估时已超过");expect(p.render()).toContain("5 分钟前");
  });
  it("binds tool updates to trusted current sender and rejects stale or invalid writes",async()=>{
    const factories: Function[]=[];
    registerAdaTaskProgressTool({registerTool:(factory:Function)=>factories.push(factory)} as never);
    const p=new TaskProgress();const release=registerTaskProgress("session","default","sender",p);
    const tool=factories[0]({sessionKey:"session",messageChannel:"feishu",agentAccountId:"default",requesterSenderId:"sender"});
    const update={completed:["核验了范围"],current:"查询状态",remaining:["核验结果"]};
    try {
      expect(await tool.execute("id",update)).toMatchObject({details:{recorded:true}});expect(p.render()).toContain("核验了范围");
      const wrongAccount=factories[0]({sessionKey:"session",messageChannel:"feishu",agentAccountId:"other",requesterSenderId:"sender"});
      expect(await wrongAccount.execute("id",update)).toMatchObject({isError:true,details:{recorded:false}});
      const other=factories[0]({sessionKey:"session",messageChannel:"feishu",agentAccountId:"default",requesterSenderId:"other"});
      expect((await other.execute("id",update)).isError).toBe(true);
      expect(await tool.execute("id",{...update,estimate:{minMinutes:4,maxMinutes:2,basis:"guess"}})).toMatchObject({isError:true,details:{recorded:false}});
      const next=registerTaskProgress("session","default","sender",new TaskProgress());
      try{expect((await tool.execute("id",update)).isError).toBe(true);}finally{next();}
    }finally{release();}
    expect(factories[0]({sessionKey:"session",messageChannel:"slack"})).toBeNull();
  });
});

it('renders operator progress templates and greeting defaults',()=>{
 const progress=new TaskProgress({workingCard:{progressTemplate:'{greeting}Done: {completed}; Current: {current}; Remaining: {remaining}'},businessMessages:{progressGreeting:'Hello. '}});
 progress.update({completed:['Checked'],current:'Reading',remaining:['Verify']});
 expect(progress.render()).toBe('Hello. Done: Checked; Current: Reading; Remaining: Verify');
});

it("configures placeholder values before and after tool activity, stale estimates and delivery",()=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 const p=new TaskProgress({workingCard:{progressTemplate:"{ageNotice}|{completed}|{current}|{remaining}|{eta}"},businessMessages:{
  progressInitial:"Analyzing",progressNoCompleted:"None",progressAwait:"Await",progressEstimateUnknown:"Unknown",
  progressWait:"Waiting",progressSeparator:", ",progressEstimate:"{minMinutes}-{maxMinutes}: {basis}",
  progressEstimateExpired:"Expired",progressAge:"{minutes} min ago",progressDeliver:"Deliver",progressNext:"Next",
 }});
 expect(p.render()).toBe("|None|Analyzing|Await|Unknown");
 p.toolStarted("codex_query",{action:"wait"});expect(p.render()).toContain("|Waiting|");
 p.update({completed:["One","Two"],current:"Verify",remaining:[],estimate:{minMinutes:2,maxMinutes:4,basis:"Service"}});
 expect(p.render()).toBe("|One, Two|Verify|Deliver|2-4: Service");
 vi.setSystemTime(300_000);expect(p.render()).toBe("5 min ago|One, Two|Verify|Deliver|Expired");
 p.plan([{step:"Done",status:"completed"}]);expect(p.render()).toContain("|Next|Deliver|");
});


it("recognizes the renamed worker while preserving legacy in-flight progress",()=>{
 for(const name of ["agent_worker","codex_query"]){
  const p=new TaskProgress();p.toolStarted(name,{action:"wait"});
  expect(p.render()).toContain("等待后台任务");
 }
});
