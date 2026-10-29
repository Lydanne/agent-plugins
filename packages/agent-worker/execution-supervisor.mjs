// CLI and its supervisor share a private process group. IPC disconnection tells
// us the owning Worker died, without trusting a persisted/reusable PID.
import {spawn} from 'node:child_process';
let started=false;
function stop(){try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}}
process.on('disconnect',stop);
if(!process.connected)stop();
process.on('message',invocation=>{
 if(started)return;started=true;
 if(typeof invocation?.command!=='string'||!Array.isArray(invocation.args)||!invocation.args.every(arg=>typeof arg==='string'))return stop();
 let child;
 try{child=spawn(invocation.command,invocation.args,{stdio:['inherit','inherit','inherit']});}catch{return stop();}
 child.once('error',error=>{process.stderr.write(error.message+'\n');process.exit(1);});
 child.once('exit',(code,signal)=>{process.removeListener('disconnect',stop);process.exit(signal?1:code??1);});
});
