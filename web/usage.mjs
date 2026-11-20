const knownProviders=new Set(['claude','codex','minimax','antigravity']);
const providerOf=event=>knownProviders.has(event.provider)?event.provider:'unknown';

// Count only observed Workbench deliveries and correlated replies in the loaded window.
export function conversationUsage(messages){
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
 return [...rows.values()];
}
