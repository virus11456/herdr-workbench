// Keep unchanged message nodes alive: text selection, media and focus belong to them.
export function createMessageList(container,{create,update}){
 let scope=null,records=new Map();
 return (nextScope,entries)=>{
  let changed=false;
  if(scope!==nextScope){container.replaceChildren();records=new Map();scope=nextScope;changed=true;}
  const keys=new Set(entries.map(entry=>entry.key));
  for(const [key,record]of records)if(!keys.has(key)){record.node.remove();records.delete(key);changed=true;}
  let cursor=container.firstChild;
  for(const entry of entries){
   let record=records.get(entry.key);
   if(!record){record={node:create(entry),entry};records.set(entry.key,record);changed=true;}
   else if(entry.signature!==record.entry.signature){update(record.node,entry,record.entry);record.entry=entry;changed=true;}
   if(record.node===cursor)cursor=cursor.nextSibling;
   else{container.insertBefore(record.node,cursor);changed=true;}
  }
  return changed;
 };
}
