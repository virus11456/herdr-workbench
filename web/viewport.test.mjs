import test from 'node:test';
import assert from 'node:assert/strict';
import {viewportLayout} from './viewport.mjs';
test('resting shell never extends beyond the exposed visible rectangle',()=>{
 assert.deepEqual(viewportLayout({baselineHeight:894,visualHeight:894}),{keyboardOpen:false,height:894,top:0});
 // A hardware keyboard does not trigger software-keyboard mode.
 assert.equal(viewportLayout({baselineHeight:956,visualHeight:894,editing:true}).height,894);
 assert.equal(viewportLayout({baselineHeight:956,visualHeight:894,editing:true}).keyboardOpen,false);
});
test('software keyboard follows the visible area until dismissal finishes',()=>{
 const open=viewportLayout({baselineHeight:894,visualHeight:548,offsetTop:18,editing:true});
 assert.deepEqual(open,{keyboardOpen:true,height:548,top:18});
 assert.equal(viewportLayout({baselineHeight:894,visualHeight:548,wasKeyboardOpen:true}).keyboardOpen,true);
 assert.deepEqual(viewportLayout({baselineHeight:894,visualHeight:894,wasKeyboardOpen:true}),{keyboardOpen:false,height:894,top:0});
});
test('zoom and missing visual viewport do not resize the application shell',()=>{
 assert.equal(viewportLayout({baselineHeight:894,visualHeight:400,editing:true,scale:2}).height,894);
 assert.equal(viewportLayout({baselineHeight:894,editing:true}).height,894);
});
