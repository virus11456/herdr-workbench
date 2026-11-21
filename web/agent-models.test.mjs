import assert from 'node:assert/strict';
import {test} from 'node:test';
import {footerModel,mergeModel,terminalProvider} from './agent-models.mjs';

test('model footer uses the installed CLI status-line formats',()=>{
 assert.equal(footerModel('minimax','說明\n workspace │ Auto │ M3.1-Flash · Effort default │ Context 512K\n'),'M3.1-Flash');
 assert.equal(footerModel('antigravity','說明\n? for shortcuts    auto · Gemini 3.8 Flash · high\n'),'Gemini 3.8 Flash');
 assert.equal(footerModel('codex','說明\n GPT-6.1-Sol high · project\n'),'GPT-6.1-Sol');
 assert.equal(terminalProvider({status:{app:'mcode'}}),'minimax');
 assert.equal(terminalProvider({status:{app:'unknown'}}),null);
});

test('text above the footer, partial models and older observations are ignored',()=>{
 assert.equal(footerModel('antigravity','auto · Gemini 9 · high\n\n> '),null);
 assert.equal(footerModel('minimax','M3.1-Flash · Effort default'),null);
 const models={};
 assert.equal(mergeModel(models,'sheep','codex','GPT-6.1-Sol',20),true);
 assert.equal(mergeModel(models,'sheep','codex','new','oops'),false);
 assert.equal(mergeModel(models,'sheep','codex','GPT-older',10),false);
 assert.equal(mergeModel(models,'sheep','minimax','M3.1-Flash',25),true);
 assert.deepEqual(models.sheep,{model:'M3.1-Flash',provider:'minimax',at:25});
});
