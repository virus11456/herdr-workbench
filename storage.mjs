import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
export function validateDriveRoot(value,cloudRoot=path.join(os.homedir(),'Library/CloudStorage')){
 if(typeof value!=='string'||!value.trim()||value.length>2048)throw Error('請選擇主機已登入的 Google Drive 串流資料夾。');
 const root=fs.realpathSync(value),provider=path.resolve(cloudRoot)+path.sep+'GoogleDrive-';
 if(!root.startsWith(provider))throw Error('此路徑不在主機的 Google Drive 串流資料夾內。');
 if(!fs.statSync(root).isDirectory())throw Error('請選擇資料夾。');fs.accessSync(root,fs.constants.R_OK|fs.constants.W_OK);return root;
}
export function storageStatus(config){return{status:!config.driveRoot?'not_connected':fs.existsSync(config.driveRoot)?'configured':'needs_login',folder:config.driveRoot||null};}
export function serviceAlive(home){try{const s=JSON.parse(fs.readFileSync(path.join(home,'service-status.json')));if(s.stopped||Date.now()-s.time>180000)return false;process.kill(s.pid,0);return true;}catch{return false;}}
