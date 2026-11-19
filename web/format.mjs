// A deliberately small Markdown renderer. All user/model text becomes text nodes.
export function inline(text) {
 const parts=[];let cursor=0;const re=/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
 for(const match of text.matchAll(re)){
  if(match.index>cursor)parts.push({type:'text',text:text.slice(cursor,match.index)});
  const code=match[0][0]==='`';parts.push({type:code?'code':'strong',text:match[0].slice(code?1:2,code?-1:-2)});cursor=match.index+match[0].length;
 }
 if(cursor<text.length)parts.push({type:'text',text:text.slice(cursor)});return parts;
}
export function parseMessage(text) {
 const lines=String(text).replaceAll('\r\n','\n').split('\n'),blocks=[];let i=0;
 const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
 const special=line=>!line.trim()||/^```|^#{1,6}\s|^\s*(?:[-*]|\d+\.)\s/.test(line);
 while(i<lines.length){
  const line=lines[i];if(!line.trim()){i++;continue;}
  if(/^```/.test(line)){const body=[];i++;while(i<lines.length&&!/^```/.test(lines[i]))body.push(lines[i++]);if(i<lines.length)i++;blocks.push({type:'pre',text:body.join('\n')});continue;}
  if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])){
   const rows=[cells(line)];i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(cells(lines[i++]));blocks.push({type:'table',rows});continue;
  }
  const heading=line.match(/^#{1,6}\s+(.+)$/);if(heading){blocks.push({type:'heading',text:heading[1]});i++;continue;}
  const list=line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
  if(list){const ordered=/\d/.test(list[1]),items=[];while(i<lines.length){const next=lines[i].match(/^\s*([-*]|\d+\.)\s+(.+)$/);if(!next||/\d/.test(next[1])!==ordered)break;items.push(next[2]);i++;}blocks.push({type:ordered?'ol':'ul',items});continue;}
  const body=[line];i++;while(i<lines.length&&!special(lines[i])&&!(lines[i].includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1]||'')))body.push(lines[i++]);blocks.push({type:'p',text:body.join('\n')});
 }
 return blocks;
}
export function formatMessage(document,text) {
 const root=document.createElement('div');root.className='message-text';
 const add=(node,text)=>{for(const part of inline(text)){if(part.type==='text')node.append(document.createTextNode(part.text));else{const child=document.createElement(part.type);child.textContent=part.text;node.append(child);}}};
 for(const b of parseMessage(text)){
  if(b.type==='table'){
   const wrap=document.createElement('div');wrap.className='message-table';wrap.tabIndex=0;wrap.setAttribute('aria-label','表格，可左右捲動');const table=document.createElement('table');
   b.rows.forEach((row,i)=>{const tr=document.createElement('tr');for(const value of row){const td=document.createElement(i?'td':'th');if(!i)td.scope='col';add(td,value);tr.append(td);}table.append(tr);});wrap.append(table);root.append(wrap);continue;
  }
  const node=document.createElement(b.type==='heading'?'h3':b.type);
  if(b.items){for(const item of b.items){const li=document.createElement('li');add(li,item);node.append(li);}}
  else if(b.type==='pre'){const code=document.createElement('code');code.textContent=b.text;node.append(code);}
  else add(node,b.text);root.append(node);
 }
 return root;
}
