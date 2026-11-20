// Contained viewport: use only the rectangle WebKit exposes as visible.
// Expanding to 100vh can place the composer behind iOS system chrome.
export function viewportLayout({baselineHeight,visualHeight,offsetTop=0,scale=1,editing=false,wasKeyboardOpen=false}) {
 const validVisual=scale===1&&Number.isFinite(visualHeight)&&visualHeight>0;
 const height=Math.round(validVisual?Math.min(baselineHeight,visualHeight):baselineHeight);
 const keyboardOpen=validVisual&&(editing||wasKeyboardOpen)&&baselineHeight-visualHeight>120;
 return {keyboardOpen,height,top:keyboardOpen?Math.max(0,Math.round(offsetTop)):0};
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
  root.style.setProperty('--app-height',layout.height+'px');
  root.style.setProperty('--keyboard-height',layout.height+'px');
  root.style.setProperty('--keyboard-top',layout.top+'px');
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

export function layoutDiagnostics(win,doc){
 const rect=id=>{const r=doc.getElementById(id)?.getBoundingClientRect();return r?{top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height)}:null;};
 const view=win.visualViewport,header=doc.querySelector('header'),style=header?win.getComputedStyle(header):null;
 return {build:doc.documentElement.dataset.layoutBuild||'unknown',standalone:win.matchMedia('(display-mode:standalone)').matches||win.navigator.standalone===true,screen:{width:win.screen.width,height:win.screen.height},window:{width:win.innerWidth,height:win.innerHeight},document:{width:doc.documentElement.clientWidth,height:doc.documentElement.clientHeight},visualViewport:view?{height:Math.round(view.height),offsetTop:Math.round(view.offsetTop),scale:view.scale}:null,keyboardOpen:doc.documentElement.classList.contains('keyboard-open'),app:rect('app'),composer:rect('composer'),header:header?{top:Math.round(header.getBoundingClientRect().top),bottom:Math.round(header.getBoundingClientRect().bottom),filter:style.filter,backdropFilter:style.backdropFilter,transform:style.transform}:null};
}
