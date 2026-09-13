import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessIdentityError } from '../lib/process-identity.mjs';
import { waitForNormalExit } from '../scripts/lib/wait-normal-exit.mjs';
const identity={pid:123,started:'1788903816.252680',executable:'/Applications/Example.app/Contents/MacOS/Example',uid:501};
function clock(){let time=0;return{now:()=>time,pause:async ms=>{time+=ms},deadline:1000};}
test('transient identity failure during exit waits for positive absence and empty registry',async()=>{
  let calls=0;
  const result=await waitForNormalExit({identity,...clock(),readIdentity:async()=>{
    if(calls++===0)throw new ProcessIdentityError('proc_pidinfo unavailable',{code:'EPERM'});
    return calls===2?identity:null;
  },readRegistration:async()=>calls===2?[{pid:identity.pid}]:[]});
  assert.equal(result.normalQuit,true);assert.equal(result.lookupWarnings.length,1);assert.equal(calls,3);
});
test('persistent lookup errors never establish absence even with empty registry',async()=>{
  await assert.rejects(waitForNormalExit({identity,...clock(),readIdentity:async()=>{throw new ProcessIdentityError('unknown',{code:'EPERM'})},readRegistration:async()=>[]}),/not confirmed/);
});
test('a reused PID or replacement registration is rejected immediately',async()=>{
  await assert.rejects(waitForNormalExit({identity,...clock(),readIdentity:async()=>({...identity,started:'1788903817.000001'}),readRegistration:async()=>[]}),/PID was reused/);
  await assert.rejects(waitForNormalExit({identity,...clock(),readIdentity:async()=>null,readRegistration:async()=>[{pid:124}]}),/replacement app/);
});
test('confirmed process-change errors and unrelated reader errors are not retried',async()=>{
  for(const error of [new ProcessIdentityError('changed',{code:'PROCESS_CHANGED'}),new Error('bad schema')]){
    let calls=0;
    await assert.rejects(waitForNormalExit({identity,...clock(),readIdentity:async()=>{calls++;throw error},readRegistration:async()=>[]}),e=>e===error);
    assert.equal(calls,1);
  }
});
