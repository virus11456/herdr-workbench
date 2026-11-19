import test from 'node:test';import assert from 'node:assert/strict';
import {parseMessage,inline,formatMessage} from './format.mjs';
test('model replies display paragraphs, emphasis, lists, tables and code',()=>{
 const blocks=parseMessage('**完成**\n\n- Claude：通過\n- Codex：通過\n\n| 名稱 | 結果 |\n| --- | --- |\n| MiniMax | 70 |\n\n```js\nconst x = 70;\n```');
 assert.deepEqual(blocks.map(b=>b.type),['p','ul','table','pre']);assert.equal(blocks[1].items.length,2);assert.equal(blocks[2].rows[1][1],'70');assert.equal(inline('**完成**')[0].type,'strong');assert.equal(blocks[3].text,'const x = 70;');
});
test('raw HTML, script and link payloads remain inert text, including in tables',()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];}append(...children){this.children.push(...children);}setAttribute(){}set innerHTML(_){throw Error('HTML injection');}}
 const doc={createElement:tag=>new Element(tag),createTextNode:text=>({text})};
 const payload='<img src=x onerror=alert(1)> **safe** [x](javascript:alert(1))';
 const root=formatMessage(doc,payload);assert.equal(root.children[0].tag,'p');assert.equal(root.children[0].children[0].text,'<img src=x onerror=alert(1)> ');
 assert.match(root.children[0].children.at(-1).text,/javascript:/);
});
