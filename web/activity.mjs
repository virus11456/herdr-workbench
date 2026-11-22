export function agentConnected(terminal){
 return terminal?.state==='live'&&!!terminal.status?.app&&['idle','done','working'].includes(terminal.status.state);
}

// A receipt belongs to one exact message and recipient, never to a later turn.
export function messageReceipt({messageId,agentId=null,messages=[],taskControls={}}){
 const belongs=m=>agentId?m.direct&&(m.target||m.agentId)===agentId:!m.direct;
 const user=messages.find(m=>m.kind==='user'&&m.messageId===messageId&&belongs(m));
 if(!user)return null;
 if(['cancelled','stopped'].includes(taskControls[messageId]))return taskControls[messageId];
 if(messages.some(m=>m.kind==='reply'&&m.replyTo===messageId&&belongs(m)))return 'replied';
 const delivery=messages.findLast(m=>m.kind==='delivery'&&m.messageId===messageId);
 return delivery?.delivery==='sent'?'sent':'queued';
}

export function agentActivity(terminal,{pending=false,starting=false}={}){
 if(terminal?.state==='finished')return '';
 if(terminal?.status?.state==='blocked'||terminal?.status?.state==='error')return '';
 if(terminal?.waitingCollaboration)return '';
 if(terminal?.status?.state==='working')return 'working';
 if((!terminal||!terminal.status?.app)&&(pending||starting))return 'starting';
 return '';
}

function replyPhase({messages=[],agentId=null,terminal,name='領頭羊',posting=false,stopped=false,taskControls={}}){
 if(posting)return{phase:'sending',text:'正在傳送訊息',animate:true};
 const belongs=m=>agentId?m.direct&&m.target===agentId:!m.direct;
 const user=messages.findLast(m=>m.kind==='user'&&belongs(m));if(!user||['cancelled','stopped'].includes(taskControls[user.messageId]))return null;
 const delivery=messages.findLast(m=>m.kind==='delivery'&&m.messageId===user.messageId&&m.delivery==='sent');
 const replied=delivery&&messages.some(m=>m.kind==='reply'&&belongs(m)&&(m.replyTo?m.replyTo===user.messageId:Date.parse(m.time)>=Date.parse(delivery.time)));
 // A later owner task must never revive the elapsed clock of an answered chat.
 if(replied)return null;
 if(terminal?.status?.state==='blocked')return{phase:'blocked',text:`${name} 等待你確認權限`,animate:false};
 if(stopped||terminal?.status?.state==='error'||(terminal?.state==='finished'&&delivery))return{phase:'stopped',text:`${name} 已停止，訊息與對話仍保留`,animate:false};
 if(!delivery){
  if(terminal?.waitingReplyCapture&&terminal.awaitingReplyMessageId&&terminal.awaitingReplyMessageId!==user.messageId)return{phase:'queued',text:`這則已排隊，正在核對 ${name} 上一則回覆`,animate:false,waitingPriorReply:true};
  const busy=terminal?.state==='live'&&terminal?.status?.state==='working';
  return{phase:'queued',text:busy?`這則已排隊，${name} 正在處理前一則`:`等待 ${name} 接收`,animate:true};
 }
 if(terminal?.waitingCollaboration)return{phase:'collaboration',text:`${name} 正在等協作回報`,animate:true};
 if(terminal?.status?.state==='working')return{phase:'working',text:`${name} 已收到，正在回覆`,animate:true};
 return{phase:'unconfirmed',text:`已送達 ${name}，回覆未核對`,animate:false};
}

export function replyProgress(args){
 const progress=replyPhase(args);if(!progress||args.posting)return progress;
 const {messages=[],agentId=null,terminal,now=Date.now()}=args;
 const belongs=m=>agentId?m.direct&&(m.target||m.agentId)===agentId:!m.direct;
 const user=messages.findLast(m=>m.kind==='user'&&belongs(m));
 const began=Date.parse(user?.time),observed=messages.filter(m=>belongs(m)&&Date.parse(m.time)>=began);
 const last=Math.max(began,...observed.map(m=>Date.parse(m.time)),Number(terminal?.observedAt)||0);
 const elapsed=Number.isFinite(began)?Math.max(0,Math.floor((now-began)/1000)):0;
 const quiet=Number.isFinite(last)?Math.max(0,Math.floor((now-last)/1000)):0;
 const reason=progress.phase==='blocked'?'請在主機確認提示':progress.phase==='collaboration'?'等待其他代理回報':
  progress.phase==='queued'?progress.waitingPriorReply?'上一則已送達，正在核對回覆；這則仍在排隊':terminal?.status?.state==='working'?'前一個回合仍在處理':'等待代理啟動或接收':
  progress.phase==='working'?'模型正在處理任務':progress.phase==='unconfirmed'?'等待回覆核對':'請查看任務狀態';
 return {...progress,elapsedSeconds:elapsed,lastProgressAt:Number.isFinite(last)?last:null,reason,
  stalled:quiet>=90&&!['blocked','stopped'].includes(progress.phase)};
}
