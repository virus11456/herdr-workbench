// Pixel scene projection only: never dispatches work or alters agent state.
const NS='http://www.w3.org/2000/svg';
export const canRoam=phase=>['working','ready','starting','collaboration'].includes(phase);
export function moveToward(point,target,seconds,speed){const dx=target.x-point.x,dy=target.y-point.y,d=Math.hypot(dx,dy),step=Math.max(0,seconds)*speed;if(!d||step>=d)return{...target};return{x:point.x+dx/d*step,y:point.y+dy/d*step};}
function seed(id){let h=2166136261;for(const c of id)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
export function createPasture(area,{onSelect,win=window}={}){
 const doc=area.ownerDocument,map=doc.createElementNS(NS,'svg');map.setAttribute('class','pixel-map');map.setAttribute('aria-hidden','true');area.replaceChildren(map);const actors=new Map();let width=0,height=0,last=0,frame,disposed=false,inView=true;
 const reduced=win.matchMedia('(prefers-reduced-motion: reduce)'),hovered=new Set();
 function drawMap(){const w=Math.ceil(width/3),h=Math.ceil(height/3);map.setAttribute('viewBox',`0 0 ${w} ${h}`);map.setAttribute('preserveAspectRatio','none');const rect=(x,y,a,b,c)=>`<rect x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.max(1,Math.round(a))}" height="${Math.max(1,Math.round(b))}" fill="${c}"/>`;let art=rect(0,0,w,h,'#65844b')+rect(0,0,w,22,'#334e3e');
  // Grass tile flecks, a cottage, notice board, water and split-rail fencing.
  for(let y=30;y<h-7;y+=12)for(let x=(y%24?5:13);x<w;x+=18)art+=rect(x,y,1,2,'#8da05b')+rect(x+2,y-1,1,2,'#8da05b');
  art+=rect(7,15,28,22,'#b28b61')+rect(10,12,22,3,'#78564b')+rect(13,9,16,3,'#78564b')+rect(17,6,8,3,'#78564b')+rect(18,24,8,13,'#443e35')+rect(10,19,5,5,'#a6c8b2');
  art+=rect(w-31,14,2,23,'#98724b')+rect(w-15,14,2,23,'#98724b')+rect(w-34,12,24,15,'#6a4d35')+rect(w-31,15,18,9,'#d7c79c')+rect(w-24,16,2,4,'#8d543d')+rect(w-24,22,2,1,'#8d543d');
  art+=rect(w-36,h-29,24,15,'#477d83')+rect(w-39,h-25,30,7,'#477d83')+rect(w-32,h-26,8,1,'#93b5a5')+rect(w-24,h-21,10,1,'#93b5a5');
  art+=rect(0,h-7,w,2,'#c9b68b')+rect(0,h-14,w,2,'#c9b68b');for(let x=3;x<w;x+=15)art+=rect(x,h-17,2,17,'#c9b68b');map.innerHTML=art;
 }
 function resize(){const next=area.clientWidth;if(!next)return;const cols=Math.max(2,Math.floor(next/110)),nextHeight=Math.max(300,Math.ceil(actors.size/cols)*88+80);if(next===width&&nextHeight===height)return;width=next;height=nextHeight;area.style.height=height+'px';drawMap();for(const a of actors.values()){a.point.x=Math.min(Math.max(4,a.point.x),Math.max(4,width-88));a.point.y=Math.min(Math.max(44,a.point.y),height-90);a.target={...a.point};}paint();}
 function station(a,i){const maxX=Math.max(4,width-88),maxY=Math.max(44,height-90),h=seed(a.id);if(a.phase==='blocked'||a.phase==='error')return{x:maxX-((i%2)*48),y:48+Math.floor(i/2)*62%Math.max(62,maxY-46)};if(a.phase==='offline')return{x:8+(i%2)*62,y:48+Math.floor(i/2)*72%Math.max(72,maxY-44)};return{x:Math.min(maxX,12+(i%Math.max(2,Math.floor(width/100)))*94),y:Math.min(maxY,125+Math.floor(i/Math.max(2,Math.floor(width/100)))*84)};}
 function chooseTarget(a){a.tick++;const h=seed(a.id+':'+a.tick),maxX=Math.max(8,width-88),maxY=Math.max(70,height-90);return{x:8+h%Math.max(1,Math.floor(maxX-8)),y:65+(h>>>12)%Math.max(1,Math.floor(maxY-65))};}
 function paint(){for(const a of actors.values()){const x=Math.round(a.point.x/3)*3,y=Math.round(a.point.y/3)*3;a.button.style.transform=`translate3d(${x}px,${y}px,0)`;a.button.style.zIndex=String(Math.round(y));}}
 function stop(){if(frame)win.cancelAnimationFrame(frame);frame=null;last=0;for(const a of actors.values())a.button.classList.remove('walking');}
 function visible(){return !disposed&&inView&&!reduced.matches&&!doc.hidden&&area.getClientRects().length>0;}
 function loop(now){frame=null;if(!visible()){stop();return;}const dt=last?Math.min((now-last)/1000,.1):0;last=now;let changed=false;
  for(const a of actors.values()){if(!canRoam(a.phase)||hovered.has(a.id)||a.button.contains(doc.activeElement)){a.button.classList.remove('walking');continue;}if(Math.hypot(a.point.x-a.target.x,a.point.y-a.target.y)<5)a.target=chooseTarget(a);const speed=a.phase==='working'?27:a.phase==='starting'?20:9,next=moveToward(a.point,a.target,dt,speed);
   const collision=[...actors.values()].some(b=>b!==a&&Math.abs(next.x-b.point.x)<84&&Math.abs(next.y-b.point.y)<70&&Math.hypot(next.x-b.point.x,next.y-b.point.y)<=Math.hypot(a.point.x-b.point.x,a.point.y-b.point.y));if(collision){a.target=chooseTarget(a);a.button.classList.remove('walking');continue;}
   a.button.classList.add('walking');a.button.dataset.facing=next.x<a.point.x?'left':'right';a.point=next;changed=true;
  }if(changed)paint();frame=win.requestAnimationFrame(loop);
 }
 function wake(){if(visible()&&!frame)frame=win.requestAnimationFrame(loop);else if(!visible())stop();}
 function update(sheep,selected){resize();const ids=new Set(sheep.map(a=>a.id||'__coordinator__'));for(const[id,a]of actors)if(!ids.has(id)){a.button.remove();actors.delete(id);hovered.delete(id);}
  const phaseSlots={};for(const [i,s]of sheep.entries()){const id=s.id||'__coordinator__';let a=actors.get(id);if(!a){const b=doc.createElement('button');b.type='button';b.className='pasture-sheep pixel-agent';b.dataset.agent=id;const figure=doc.createElement('span');figure.className='pasture-figure';const img=doc.createElement('img');img.className='pixel-sprite';img.src='./pixel-sheep.svg';img.alt='';const dot=doc.createElement('span');dot.className='live-dot';dot.setAttribute('aria-hidden','true');const marker=doc.createElement('span');marker.className='sheep-alert';marker.textContent='!';figure.append(img,dot,marker);const name=doc.createElement('strong'),state=doc.createElement('span');state.className='pasture-state';b.append(figure,name,state);a={id,button:b,name,state,dot,marker,point:{x:0,y:70},target:{x:0,y:70},phase:null,tick:0};actors.set(id,a);b.onclick=()=>onSelect(s.id);b.onpointerenter=()=>hovered.add(id);b.onpointerleave=()=>hovered.delete(id);area.append(b);}
   const changed=a.phase!==s.phase;a.phase=s.phase;a.button.dataset.phase=s.phase;a.button.setAttribute('aria-pressed',String((s.id||null)===(selected||null)));a.button.setAttribute('aria-label',s.name+'，'+s.label);a.button.title=s.name+' · '+s.label;a.name.textContent=s.name;a.state.textContent=s.label;a.dot.className='live-dot'+(s.connected?' is-connected':'')+(s.phase==='working'&&s.connected?' is-busy':'');a.marker.hidden=!['blocked','error'].includes(s.phase);const slot=phaseSlots[s.phase]||0;phaseSlots[s.phase]=slot+1;if(changed){a.point=station(a,['blocked','error','offline'].includes(s.phase)?slot:i);a.target={...a.point};a.button.classList.remove('walking');}
  }resize();paint();wake();
 }
 const observer=new win.ResizeObserver(resize);observer.observe(area);const intersection=new win.IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView)wake();else stop();});intersection.observe(area);doc.addEventListener('visibilitychange',wake);reduced.addEventListener('change',wake);const details=area.closest('details');details?.addEventListener('toggle',wake);
 return{update,destroy(){disposed=true;stop();observer.disconnect();intersection.disconnect();doc.removeEventListener('visibilitychange',wake);reduced.removeEventListener('change',wake);details?.removeEventListener('toggle',wake);}};
}
