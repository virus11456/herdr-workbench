export function agentConnected(terminal){
 return terminal?.state==='live'&&!!terminal.status?.app&&['idle','done','working'].includes(terminal.status.state);
}

export function agentActivity(terminal,{pending=false,starting=false}={}){
 if(terminal?.state==='finished')return '';
 if(terminal?.status?.state==='blocked'||terminal?.status?.state==='error')return '';
 if(terminal?.waitingCollaboration)return '';
 if(terminal?.status?.state==='working')return 'working';
 if((!terminal||!terminal.status?.app)&&(pending||starting))return 'starting';
 return '';
}

export function replyProgress({messages=[],agentId=null,terminal,name='領頭羊',posting=false,stopped=false,taskControls={}}){
 if(posting)return{phase:'sending',text:'正在傳送訊息',animate:true};
 const belongs=m=>agentId?m.direct&&m.target===agentId:!m.direct;
 const user=messages.findLast(m=>m.kind==='user'&&belongs(m));if(!user||['cancelled','stopped'].includes(taskControls[user.messageId]))return null;
 const delivery=messages.findLast(m=>m.kind==='delivery'&&m.messageId===user.messageId&&m.delivery==='sent');
 const replied=delivery&&messages.some(m=>m.kind==='reply'&&belongs(m)&&(m.replyTo?m.replyTo===user.messageId:Date.parse(m.time)>=Date.parse(delivery.time)));
 if(replied&&!terminal?.waitingCollaboration&&terminal?.status?.state!=='working')return null;
 if(terminal?.status?.state==='blocked')return{phase:'blocked',text:`${name} 等待你確認權限`,animate:false};
 if(stopped||terminal?.status?.state==='error'||(terminal?.state==='finished'&&delivery))return{phase:'stopped',text:`${name} 已停止，訊息與對話仍保留`,animate:false};
 if(!delivery)return{phase:'queued',text:`等待 ${name} 接收`,animate:true};
 if(terminal?.waitingCollaboration)return{phase:'collaboration',text:`${name} 正在等協作回報`,animate:true};
 if(terminal?.status?.state==='working')return{phase:'working',text:`${name} 已收到，正在回覆`,animate:true};
 return{phase:'delivered',text:`已送達 ${name}，等待回覆`,animate:true};
}
