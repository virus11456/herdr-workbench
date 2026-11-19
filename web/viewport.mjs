// Fullscreen CSS owns the resting size. iOS standalone innerHeight can exclude
// the status bar even when 100vh covers it; never copy that value onto the shell.
export function viewportLayout({baselineHeight,visualHeight,offsetTop=0,scale=1,editing=false,wasKeyboardOpen=false}) {
 const keyboardOpen=scale===1&&(editing||wasKeyboardOpen)&&Number.isFinite(visualHeight)&&baselineHeight-visualHeight>120;
 return {keyboardOpen,height:keyboardOpen?Math.round(visualHeight):null,top:keyboardOpen?Math.max(0,Math.round(offsetTop)):0};
}
export function bindViewport(win,doc){
 const root=doc.documentElement;
 let baselineHeight=win.innerHeight,keyboardOpen=false,frame=0,settled;
 const editing=()=>['INPUT','TEXTAREA'].includes(doc.activeElement?.tagName)||!!doc.activeElement?.isContentEditable;
 function sync(){
  frame=0;const view=win.visualViewport;
  if(!editing()&&!keyboardOpen)baselineHeight=win.innerHeight;
  else baselineHeight=Math.max(baselineHeight,win.innerHeight);
  const layout=viewportLayout({baselineHeight,visualHeight:view?.height,offsetTop:view?.offsetTop,scale:view?.scale,editing:editing(),wasKeyboardOpen:keyboardOpen});
  keyboardOpen=layout.keyboardOpen;
  root.classList.toggle('keyboard-open',keyboardOpen);
  if(layout.height===null){root.style.removeProperty('--keyboard-height');root.style.removeProperty('--keyboard-top');}
  else{root.style.setProperty('--keyboard-height',layout.height+'px');root.style.setProperty('--keyboard-top',layout.top+'px');}
 }
 function schedule(){if(!frame)frame=win.requestAnimationFrame(sync);}
 // iOS can emit focus/blur before the keyboard resize animation has finished.
 function focusChanged(){schedule();win.clearTimeout(settled);settled=win.setTimeout(schedule,350);}
 function orientationChanged(){baselineHeight=win.innerHeight;keyboardOpen=false;focusChanged();}
 win.addEventListener('pageshow',focusChanged,{passive:true});
 win.addEventListener('resize',schedule,{passive:true});
 win.addEventListener('orientationchange',orientationChanged,{passive:true});
 win.visualViewport?.addEventListener('resize',schedule,{passive:true});
 win.visualViewport?.addEventListener('scroll',schedule,{passive:true});
 doc.addEventListener('focusin',focusChanged);doc.addEventListener('focusout',focusChanged);
 sync();
}
