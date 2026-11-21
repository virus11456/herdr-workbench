import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {quotaFromStatus,quotaStatusSettings,readQuotas,saveQuota} from './provider-quota.mjs';

const now=Date.UTC(2026,10,21),observedAt=new Date(now).toISOString(),resetsAt=now/1000+60;
test('Claude status line preserves exhausted windows and hides missing or expired data',()=>{
 const payload={rate_limits:{five_hour:{used_percentage:100,resets_at:resetsAt},seven_day:{used_percentage:25,resets_at:now/1000}},context_window:{remaining_percentage:99}};
 assert.deepEqual(quotaFromStatus('claude',payload,now),{observedAt,windows:[{windowMinutes:300,remainingPercent:0,resetsAt}]});
 assert.equal(quotaFromStatus('claude',{rate_limits:{five_hour:{used_percentage:null,resets_at:resetsAt}}},now),null);
});
test('Antigravity quota fractions require an enabled bucket and a future reset',()=>{
 const reset_time=new Date(resetsAt*1000).toISOString();
 const quota={'gemini-weekly':{remaining_fraction:.825,reset_time},disabled:{remaining_fraction:1,reset_time,disabled:true},amount:{remaining_amount:50,reset_time},invalid:{remaining_fraction:100,reset_time}};
 assert.deepEqual(quotaFromStatus('antigravity',{product:'antigravity',quota},now),{observedAt,windows:[{bucket:'gemini-weekly',remainingPercent:82.5,resetsAt}]});
 assert.equal(quotaFromStatus('antigravity',{quota},now),null);
});
test('account snapshots store only quota fields and are removed from the view after expiry',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-quota-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 saveQuota(dir,'claude',{email:'private',rate_limits:{seven_day:{used_percentage:32,resets_at:resetsAt}}},now);
 const filename=path.join(dir,'provider-quota/claude.json');
 assert.equal(fs.statSync(filename).mode&0o777,0o600);
 assert.equal(fs.readFileSync(filename,'utf8').includes('private'),false);
 assert.equal(readQuotas(dir,now)[0].windows[0].remainingPercent,68);
 assert.deepEqual(readQuotas(dir,now+60_000),[]);
 assert.deepEqual(readQuotas(dir,now-1),[]);
});
test('session status line keeps existing layout options and honors explicit opt-out',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-quota-settings-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const file=path.join(home,'.claude/settings.json');
 fs.mkdirSync(path.dirname(file));
 fs.writeFileSync(file,JSON.stringify({statusLine:{type:'command',command:'example',padding:2}}));
 const generated=quotaStatusSettings('claude',home,'/usr/local/bin/node',home);
 assert.equal(generated.statusLine.padding,2);
 assert.match(generated.statusLine.command,/provider-quota\.mjs/);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).statusLine.command,'example');
 fs.writeFileSync(file,JSON.stringify({statusLine:{type:'command',command:'example',enabled:false}}));
 assert.deepEqual(quotaStatusSettings('claude',home,'/usr/local/bin/node',home),{});
});
