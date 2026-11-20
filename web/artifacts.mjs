import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const images={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const textExtensions=new Set(['.txt','.md','.csv','.tsv','.json','.jsonl','.diff','.patch','.js','.mjs','.ts','.css','.py','.go','.rs','.java','.html','.svg','.yaml','.yml']);
const maxBytes=10*1024*1024,previewLimit=256*1024;
const fail=(status,message)=>Object.assign(Error(message),{status});

export function artifactReferences(task){
 if(task?.status!=='done')return [];
 return (task.evidence||[]).flatMap((item,index)=>{
  if(typeof item?.path!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256||''))return [];
  const parts=item.path.split(/[\\/]/);
  if(parts.some(part=>!part||part.startsWith('.')||/[\u0000-\u001f]/.test(part)))return [];
  const name=parts.at(-1);
  if(/^(?:credentials?|secrets?|token|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name))return [];
  const ext=path.extname(name).toLowerCase();
  const mime=Object.hasOwn(images,ext)?images[ext]:null;
  if(!mime&&!textExtensions.has(ext)&&ext!=='.pdf')return [];
  return [{index,name,relative:item.path,sha256:item.sha256,kind:mime?'image':textExtensions.has(ext)?'text':'download',mime}];
 });
}

export async function readArtifact(c,task,index){
 const ref=artifactReferences(task).find(item=>item.index===index);
 if(!ref)throw fail(404,'找不到已驗收的成果檔案。');
 const filename=path.resolve(c.cwd,ref.relative);
 // Only regular files at the recorded project paths. Never follow an artifact symlink.
 let fd;
 try{
  if(!filename.startsWith(c.cwd+path.sep)||await fs.promises.realpath(filename)!==filename)throw fail(404,'找不到可預覽的成果檔案。');
  fd=await fs.promises.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=await fd.stat();
  if(!stat.isFile())throw fail(404,'找不到可預覽的成果檔案。');
  if(stat.size>maxBytes)throw fail(413,'成果檔案超過 10 MB。');
  const data=Buffer.alloc(stat.size);
  let read=0;
  while(read<data.length){const {bytesRead}=await fd.read(data,read,data.length-read,read);if(!bytesRead)break;read+=bytesRead;}
  if(read!==data.length||(await fd.stat()).size!==data.length||createHash('sha256').update(data).digest('hex')!==ref.sha256){
   throw fail(409,'檔案已變更，請重新驗收後再開啟。');
  }
  const text=ref.kind==='text'?data.subarray(0,previewLimit).toString('utf8'):undefined;
  return {...ref,data,text,truncated:text!==undefined&&data.length>previewLimit};
 }catch(error){
  if(error.status)throw error;
  throw fail(404,'找不到可預覽的成果檔案。');
 }finally{if(fd)await fd.close();}
}
