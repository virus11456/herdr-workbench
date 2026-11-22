import fs from 'node:fs';import path from 'node:path';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export function workerProvider(t){return ({claude:'claude','claude-code':'claude',codex:'codex',antigravity:'antigravity',minimax:'minimax',mcode:'minimax'})[t?.status?.app]||null;}
export function verifiedLegacyWorker(c,id,t,agentId){
 const binding=read(path.join(c.teamDir,'worker-bindings.json'))?.[id];
 const cwd=binding?.cwd||c.cwd;
 if(!/^t[a-z0-9]+$/.test(id||'')||!binding||binding.chat!==(c.chat||'legacy')||t?.address!==id||t.cwd!==cwd||path.resolve(cwd)!==cwd||!(cwd===c.cwd||cwd.startsWith(c.cwd+path.sep))||t.parent!==binding.owner||t.labels?.['team.owner']!==binding.owner||t.labels?.['team.chat']!==binding.chat||t.labels?.['team.direct']==='true')return null;
 if(agentId&&(binding.agentId!==agentId||t.labels?.['team.agent']&&t.labels['team.agent']!==agentId))return null;
 return binding;
}
export function workerPublicReports(c,id){
 const file=path.join(c.teamDir,'messages.jsonl');let lines;try{lines=fs.readFileSync(file,'utf8').split('\n');}catch(e){if(e.code==='ENOENT')return[];throw e;}
 return lines.flatMap(line=>{try{const row=JSON.parse(line);return row.kind==='worker-report'&&row.terminal===id?[row]:[];}catch{return[];}});
}
