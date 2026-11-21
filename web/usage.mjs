const knownProviders=new Set(['claude','codex','minimax','antigravity']);
const providerOf=event=>knownProviders.has(event.provider)?event.provider:'unknown';

// Count only observed Workbench deliveries and correlated replies in the loaded window.
export function conversationUsage(messages,records=[],now=Date.now()){
 const rows=new Map(),deliveries=new Map(),replies=new Set();
 const rowFor=provider=>{
  if(!rows.has(provider))rows.set(provider,{provider,delivered:0,replies:0});
  return rows.get(provider);
 };
 for(const event of messages){
  if(event.kind!=='delivery'||event.delivery!=='sent'||!event.messageId||deliveries.has(event.messageId))continue;
  const provider=providerOf(event);
  deliveries.set(event.messageId,{provider,target:event.target,direct:!!event.direct});
  rowFor(provider).delivered++;
 }
 for(const event of messages){
  if(event.kind!=='reply'||!event.replyTo||replies.has(event.replyTo))continue;
  const delivery=deliveries.get(event.replyTo);
  if(!delivery||delivery.direct!==!!event.direct||delivery.direct&&delivery.target!==event.target)continue;
  replies.add(event.replyTo);rowFor(delivery.provider).replies++;
 }
 const observed=new Map(),latestQuota=new Map();
 const unique=new Map(records.filter(r=>knownProviders.has(r?.provider)&&/^[a-f0-9]{64}$/.test(r.key||'')).map(r=>[r.key,r]));
 const count=n=>Number.isSafeInteger(n)&&n>=0;
 for(const {provider,tokens,quota} of unique.values()){
  if(count(tokens?.input)&&count(tokens?.output)){
   if(!observed.has(provider))observed.set(provider,[]);
   observed.get(provider).push(tokens);
  }
  if(provider==='codex'&&Array.isArray(quota?.windows)&&Date.parse(quota.observedAt)>(Date.parse(latestQuota.get(provider)?.observedAt)||0))latestQuota.set(provider,quota);
 }
 for(const [provider,samples] of observed){
  const row=rowFor(provider);row.measuredTurns=samples.length;row.tokens={};
  for(const name of ['input','output','cacheRead','cacheWrite']){
   if(samples.every(tokens=>count(tokens[name])))row.tokens[name]=samples.reduce((total,tokens)=>total+tokens[name],0);
  }
 }
 for(const [provider,quota] of latestQuota){
  const windows=quota.windows.filter(w=>w?.resetsAt*1000>now&&count(w.windowMinutes)&&w.windowMinutes>0&&Number.isFinite(w.usedPercent)&&w.usedPercent>=0&&w.usedPercent<=100);
  if(windows.length)rowFor(provider).quota={observedAt:quota.observedAt,windows};
 }
 return [...rows.values()];
}
