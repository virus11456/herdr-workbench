import {messageReceipt} from './activity.mjs';
// Transport and upgrade policy are independent of UI rendering. Never replay a
// write after losing its response, and never reload away in-memory attachments.
const buildParts=value=>typeof value==='string'?value.match(/^(\d{8})-[a-z0-9-]*?(\d{1,5})$/):null;
export function newerBuild(current,candidate){
 const a=buildParts(current),b=buildParts(candidate);
 return !!a&&!!b&&(b[1]>a[1]||b[1]===a[1]&&Number(b[2])>Number(a[2]));
}
export async function requestJSON(route,{data,scope={},csrfToken,fetch:fetcher=globalThis.fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),onBuild=()=>{}}={}){
 const write=data!==undefined;
 for(let attempt=0;attempt<(write?1:2);attempt++){
  try{
   const response=await fetcher('./api/'+route,{method:write?'POST':'GET',cache:'no-store',headers:write?{'Content-Type':'application/json','X-Herdr-CSRF':csrfToken}:{},body:write?JSON.stringify({...scope,...data}):undefined});
   onBuild(response.headers?.get('X-Herdr-UI-Build'));
   const text=await response.text();let result;
   try{result=JSON.parse(text);if(!result||typeof result!=='object'||Array.isArray(result))throw Error();}
   catch{throw Object.assign(Error(write?'主機回應不完整，操作結果尚未確認。請先檢查目前狀態後再重試。':'主機回應不完整，正在重新連線。'),{transient:true,uncertain:write});}
   if(!response.ok){const raw=typeof result.error==='string'?result.error:'';throw Error(/Unexpected end of JSON|Failed to execute ['"]json['"]|JSON\.parse/i.test(raw)?'主機回應不完整，請先核對目前狀態；不會自動重送操作。':raw||'連線失敗');}
   if(/^state(?:\?|$)/.test(route)&&(!Array.isArray(result.projects)||!Array.isArray(result.agents)||typeof result.csrfToken!=='string'))throw Object.assign(Error('主機狀態不完整，正在重新連線。'),{transient:true});
   return result;
  }catch(error){
   const transient=error.transient||error instanceof TypeError;
   if(!write&&!attempt&&transient){await wait(200);continue;}
   if(error instanceof TypeError)throw Object.assign(Error(write?'連線中斷，操作結果尚未確認。請先查看目前狀態；不會自動重送。':'連線暫時中斷，請確認主機與 Tailscale。'),{uncertain:write});
   throw error;
  }
 }
}
export function createClientUpgrade({build,status,saveDraft,storage,reload}){
 let target=null,reloading=false;
 return{
  observe(candidate){if(newerBuild(build,candidate)&&(!target||newerBuild(target,candidate)))target=candidate;},
  attempt(){
   if(!target||reloading)return false;
   const s=status();
   if(!s.ready||s.hidden||s.offline||s.posting||s.navigating||s.attachments||s.dialog||s.pending||s.editing||s.readingHistory)return false;
   const key='herdr-client-upgrade:'+target;
   try{
    if(storage.getItem(key)||!saveDraft())return false;
    storage.setItem(key,'1');if(storage.getItem(key)!=='1')return false;
   }catch{return false;}
   reloading=true;reload();return true;
  }
 };
}

export function confirmedSend(pending,state){
 if(!pending||state?.project!==pending.project||state?.chat!==pending.chat)return null;
 return messageReceipt({messageId:pending.id,agentId:pending.agentId||null,messages:state.messages,taskControls:state.taskControls});
}
export function settledDraft({pendingId,messageId,currentText,sentText,currentFiles,sentFiles}){
 if(pendingId!==messageId||currentText!==sentText)return{files:currentFiles,clearText:false};
 const files=currentFiles.filter(file=>!sentFiles.includes(file));return{files,clearText:files.length===0};
}
