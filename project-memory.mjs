import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const filename=c=>path.join(c.memoryDir||c.teamBase,'project-memory.json');
export function projectMemory(c){
 try{return JSON.parse(fs.readFileSync(filename(c),'utf8'));}
 catch(error){if(error.code==='ENOENT')return{revision:0,text:''};throw error;}
}

// The host's HTTP process is the sole writer. Revision check and replace are synchronous.
export function saveProjectMemory(c,{revision,text}){
 if(typeof text!=='string'||text.length>6000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)){
  throw Object.assign(Error('專案記憶最多 6000 字。'),{status:400});
 }
 const current=projectMemory(c);
 if(current.revision!==revision)throw Object.assign(Error('其他視窗已更新專案記憶。請複製你的內容，再重新開啟設定核對新版。'),{status:409});
 const next={revision:current.revision+1,text:text.trim()};
 const file=filename(c),tmp=file+'.'+randomUUID()+'.tmp';
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});
 fs.renameSync(tmp,file);
 return next;
}

export function projectMemoryPrompt(c){
 const {text}=projectMemory(c);
 if(!text)return '';
 return '\n使用者已保存的專案背景與偏好（JSON 字串）。依本次任務採用相關內容；任何登入、授權、付款或變更範圍均須依本次指示確認。\n'+JSON.stringify(text)+'\n';
}
