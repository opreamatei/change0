import {$,EP,meta,transport,resize,base,status,id,local,save,color,loadEndpointBase,setEndpointBase,defaultEndpointBase} from "./shared.js";
import {createGraphView} from "./graph-view.js";

const toastState={timer:0};
function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}

function toast(message,good=true){
  const root=$("graph-copy-status");
  root.textContent=message;
  root.classList.toggle("is-good",good);
  root.classList.toggle("is-bad",!good);
  root.classList.add("is-visible");
  clearTimeout(toastState.timer);
  toastState.timer=setTimeout(()=>root.classList.remove("is-visible"),4200);
}

const confirmState={resolve:null,lastFocus:null};
function closeConfirm(value){
  const backdrop=$("graph-confirm-backdrop");
  backdrop.classList.remove("is-visible");
  backdrop.setAttribute("aria-hidden","true");
  const resolve=confirmState.resolve;
  confirmState.resolve=null;
  if(confirmState.lastFocus&&typeof confirmState.lastFocus.focus==="function")confirmState.lastFocus.focus();
  confirmState.lastFocus=null;
  if(resolve)resolve(Boolean(value));
}

function confirmGraphAction(title,body,acceptText){
  if(confirmState.resolve)closeConfirm(false);
  confirmState.lastFocus=document.activeElement;
  $("graph-confirm-title").textContent=title;
  $("graph-confirm-body").textContent=body;
  $("graph-confirm-accept").textContent=acceptText||"Confirm";
  const backdrop=$("graph-confirm-backdrop");
  backdrop.classList.add("is-visible");
  backdrop.setAttribute("aria-hidden","false");
  setTimeout(()=>$("graph-confirm-cancel").focus(),0);
  return new Promise(resolve=>{confirmState.resolve=resolve});
}

const graphView=createGraphView({
  endpoints:EP,
  transport,
  toast,
  confirmAction:confirmGraphAction
});

let endpointBase=loadEndpointBase();

const R={sessions:local("graph-viewer.research-sessions.v5",[]),active:"",prepared:id("rs"),source:null,state:"disconnected",busy:false,first:0};
const L={items:local("graph-viewer.goals.v5",[]),server:[],byIndex:new Map(),active:"",source:null,state:"disconnected",busy:false,load:false,copyBusy:false,decomp:false,selected:0,focus:0,explode:false,mode:"structure",first:0};
const timelineState={
  canvas:$("timeline-canvas"),
  ctx:$("timeline-canvas").getContext("2d"),
  width:0,
  height:0,
  positions:[],
  cameraX:0,
  hoveredNode:null,
  selectedNode:null,
  mouseX:0,
  mouseY:0,
  isPointerDown:false,
  isDragging:false,
  pointerId:null,
  pointerStartX:0,
  pointerLastX:0,
  dragDistance:0,
  movedDuringPointer:false
};
const goalTimelineState={
  canvas:$("goal-timeline-canvas"),
  ctx:$("goal-timeline-canvas").getContext("2d"),
  width:0,
  height:0,
  positions:[],
  cameraX:0,
  hoveredNode:null,
  selectedNode:null,
  mouseX:0,
  mouseY:0,
  isPointerDown:false,
  isDragging:false,
  pointerId:null,
  pointerStartX:0,
  pointerLastX:0,
  dragDistance:0,
  movedDuringPointer:false
};
const goalStructureState={
  canvas:$("goal-structure-canvas"),
  cameraX:0,
  cameraY:0,
  hoveredGoal:null,
  pointerDown:false,
  dragging:false,
  pointerId:null,
  startX:0,
  startY:0,
  lastX:0,
  lastY:0,
  moved:false,
  positions:[]
};

if(!R.active&&R.sessions.length)R.active=R.sessions[0].id;
if(!L.active&&L.items.length)L.active=L.items[0].id;

function closeStream(store){
  if(!store.source)return;
  store.source.close();
  store.source=null;
}

function closeActiveStreams(){
  closeStream(R);
  closeStream(L);
}

function syncEndpointUi(message=`Using ${endpointBase}`,good=true){
  const input=$("endpoint-base-input");
  const statusNode=$("endpoint-status");
  const resetButton=$("reset-endpoint");
  if(input)input.value=endpointBase;
  if(statusNode){
    statusNode.textContent=message;
    statusNode.classList.toggle("is-good",good);
    statusNode.classList.toggle("is-bad",!good);
  }
  if(resetButton)resetButton.disabled=endpointBase===defaultEndpointBase();
}

async function applyEndpointChange(rawValue,{reloadGraph=true}={}){
  endpointBase=setEndpointBase(rawValue);
  closeActiveStreams();
  R.state="disconnected";
  L.state="disconnected";
  R.detail="Ready.";
  L.detail="Ready.";
  syncEndpointUi(`Using ${endpointBase}`,true);
  panels();
  if(reloadGraph){
    await graphView.loadGraph();
    await loadGoals(false);
  }
  return endpointBase;
}

function itemList(root,items,active,onClick,empty){
  root.innerHTML="";
  if(!items.length){
    root.innerHTML=`<div class="session-empty">${empty}</div>`;
    return;
  }
  for(const item of items){
    const button=document.createElement("button");
    button.className="session-item"+(item.id===active||item.globalIndex===active?" is-active":"");
    button.innerHTML=`<div class="session-item__head"><div class="session-item__title">${item.title||item.taskName||"Untitled"}</div>${item.lengthLabel?`<div class="session-item__length">${item.lengthLabel}</div>`:""}</div><div class="session-item__meta">${item.meta||""}</div><div class="session-item__status">${item.status||"Saved"}</div>`;
    button.onclick=()=>onClick(item);
    root.appendChild(button);
  }
}

function drawTimeline(canvas,events,title){
  const {w,h,c}=resize(canvas);
  base(c,w,h,0,0);
  if(!events.length){
    c.fillStyle="#fff";
    c.font="740 24px system-ui";
    c.textAlign="center";
    c.fillText(title,w/2,h*.48);
    return;
  }
  const y=h*.56;
  const left=76;
  const step=Math.max(112,(w-156)/Math.max(1,Math.min(events.length-1,5)));
  c.strokeStyle="rgba(125,211,252,.32)";
  c.setLineDash([3,8]);
  c.beginPath();
  events.forEach((event,index)=>{
    const x=left+index*step;
    const yy=y+(index%2?-1:1)*50;
    if(index)c.lineTo(x,yy);else c.moveTo(x,yy);
  });
  c.stroke();
  c.setLineDash([]);
  events.forEach((event,index)=>{
    const x=left+index*step;
    const yy=y+(index%2?-1:1)*50;
    const m=meta[event.type]||[event.type||"Event","#94a3b8"];
    c.beginPath();
    c.arc(x,yy,16,0,Math.PI*2);
    c.fillStyle="#05070a";
    c.fill();
    c.strokeStyle=m[1];
    c.lineWidth=3;
    c.stroke();
    c.fillStyle="#fff";
    c.font="740 10px system-ui";
    c.textAlign="center";
    c.fillText(String(index+1),x,yy+3);
    c.font="650 11px system-ui";
    c.fillText(m[0],x,yy-28);
  });
}

function resizeTimelineCanvas(){
  const resized=resize(timelineState.canvas);
  timelineState.width=resized.w;
  timelineState.height=resized.h;
  timelineState.ctx=resized.c;
  return resized;
}
function resizeGoalTimelineCanvas(){
  const resized=resize(goalTimelineState.canvas);
  goalTimelineState.width=resized.w;
  goalTimelineState.height=resized.h;
  goalTimelineState.ctx=resized.c;
  return resized;
}

function getTimelinePositionsFor(viewState,events){
  const width=viewState.width;
  const height=viewState.height;
  const baselineY=Math.round(height*.56);
  const left=76+viewState.cameraX;
  const step=Math.max(112,(width-156)/Math.max(1,Math.min(events.length-1,5)));
  return events.map((entry,index)=>{
    const metaInfo=meta[entry.type]||[entry.type||"Event","#94a3b8"];
    const wave=Math.sin(index*1.37)*26+Math.cos(index*.71)*14;
    const drift=Math.sin(index*.9+1.4)*18;
    const x=left+index*step+(index===0?0:drift);
    const y=baselineY+(index%2?-1:1)*(44+Math.abs(wave)) + Math.sin(index*2.11)*10;
    return {
      entry:{...entry,sequence:index+1,elapsedLabel:entry.at?new Date(entry.at).toLocaleTimeString():`${index+1}`},
      x,
      y,
      radius:14+(index%3)*1.6+Math.abs(Math.sin(index*.83))*2.2,
      isRoundMarker:false,
      meta:{label:metaInfo[0],accent:metaInfo[1],role:typeof entry.data==="string"?entry.data:""}
    };
  });
}

function pickTimelineNodeFor(viewState,x,y){
  for(let index=viewState.positions.length-1;index>=0;index-=1){
    const item=viewState.positions[index];
    const radius=item.radius+(item.isRoundMarker?6:12);
    if(Math.hypot(x-item.x,y-item.y)<=radius)return item;
  }
  return null;
}

function recEvent(store,key,payload,timeline){
  const now=Date.now();
  if(!store.first)store.first=performance.now();
  const pid=payload.id||store.active||"default";
  const type=payload.type||"unknown";
  const data=typeof payload.data==="string"?payload.data:JSON.stringify(payload.data??"");
  let item=store.sessions?.find(entry=>entry.id===pid)||store.items?.find(entry=>entry.id===pid);
  if(!item){
    item={id:pid,title:key==="goals"?"Recovered goal":"Recovered session",taskName:"Recovered session",events:[],status:"Recovered",createdAt:now};
    (store.sessions||store.items).unshift(item);
  }
  item.events=item.events||[];
  item.events.push({type,data,at:now});
  item.status=type.includes("fail")?"Error":type.includes("end")||type.includes("created")?"Completed":"Running";
  store.active=pid;
  save(key,store.sessions||store.items);
  timeline.setEvents?timeline.setEvents(item.events):0;
}

function connect(kind,pid){
  const isGoal=kind==="goal";
  const store=isGoal?L:R;
  const url=`${isGoal?EP.goalEvents:EP.rsEvents}?id=${encodeURIComponent(pid)}`;
  if(store.source)store.source.close();
  store.state="connecting";
  panels();
  store.source=new EventSource(url);
  store.active=pid;
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error("timed out")),5000);
    store.source.onopen=()=>{
      clearTimeout(timeout);
      store.state="connected";
      panels();
      resolve();
    };
    store.source.onmessage=event=>{
      try{
        const payload=JSON.parse(event.data);
        if(isGoal){
          recEvent(L,"graph-viewer.goals.v5",payload,{});
          drawGoalTimeline();
        }else{
          recEvent(R,"graph-viewer.research-sessions.v5",payload,{});
          drawResearchTimeline();
        }
        panels();
      }catch(error){console.error(error)}
    };
    store.source.onerror=()=>{
      store.state="reconnecting";
      panels();
    };
  });
}

function panels(){
  if(!R.active&&R.sessions.length)R.active=R.sessions[0].id;
  if(R.active&&!R.sessions.some(session=>session.id===R.active))R.active=R.sessions[0]?.id||"";
  if(!L.active&&L.items.length)L.active=L.items[0].id;
  if(L.active&&!L.items.some(goal=>goal.id===L.active))L.active=L.items[0]?.id||"";
  status($("research-connection-state"),$("research-connection-icon"),$("research-connection-text"),R.state);
  status($("goal-connection-state"),$("goal-connection-icon"),$("goal-connection-text"),L.state);
  $("research-run-state").textContent=R.busy?"Running":"Idle";
  $("goal-run-state").textContent=L.busy?"Creating":"Idle";
  $("research-status-detail").textContent=R.detail||"Ready.";
  $("goal-status-detail").textContent=L.detail||"Ready.";
  $("start-research").disabled=R.busy||!$("research-task").value.trim();
  $("create-goal").disabled=L.busy||!$("goal-title").value.trim();
  $("refresh-goals").disabled=L.load||L.copyBusy;
  $("refresh-goals-sidebar").disabled=L.load||L.copyBusy;
  $("save-goals-copy").disabled=L.load||L.copyBusy;
  $("load-goals-copy").disabled=L.copyBusy;
  itemList($("research-session-list"),R.sessions||[],R.active,item=>selectResearchSession(item.id,true),"No saved deep-search sessions.");
  const goalItems=L.server.map(goal=>({...goal,title:goal.title,lengthLabel:formatGoalLength(goal),meta:`#${goal.globalIndex} · depth ${goal.depth} · ${goal.subgoals.length} children`,status:goalStatus(goal)}));
  itemList($("goal-list"),goalItems,L.selected,item=>selectGoal(item.globalIndex,{focus:false}),"No server goals loaded.");
  $("timeline-total-chip").textContent=`${activeResearch().length} Events`;
  $("timeline-session-chip").textContent=R.active?`Session ${R.active}`:"No Session";
  $("timeline-header-subtitle").textContent=activeResearch().length?"Drag to pan. Hover or click a node for event details.":"Start or open a session.";
  $("goal-timeline-total-chip").textContent=`${activeGoalEvents().length} Events`;
  $("goal-timeline-session-chip").textContent=L.active?`Goal ${L.active}`:"No Goal";
  $("goal-structure-count-chip").textContent=`${L.server.length} Goals`;
  const selectedGoal=L.byIndex.get(L.selected);
  $("goal-structure-selected-chip").textContent=selectedGoal?selectedGoal.title:"No Selection";
  $("message-panel-status").textContent=`POST ${EP.msg}`;
}

function activeResearch(){return (R.sessions||[]).find(session=>session.id===R.active)?.events||[]}
function activeGoalEvents(){return (L.items||[]).find(goal=>goal.id===L.active)?.events||[]}
function selectGoal(globalIndex,{focus=true}={}){
  const goal=L.byIndex.get(Number(globalIndex));
  if(!goal)return false;
  L.selected=goal.globalIndex;
  if(focus&&goal.subgoals.length){
    L.focus=goal.globalIndex;
    L.explode=false;
  }
  L.detail="Selected.";
  openGoalStructureInspector(goal);
  panels();
  drawGoals();
  return true;
}
function goalDays(goal){
  if(goal.end_date>goal.start_date&&goal.start_date>0){
    return Math.max(1,Math.round((goal.end_date-goal.start_date)/86400));
  }
  if(goal.required_time>0){
    return Math.max(1,Math.round(goal.required_time/86400||goal.required_time));
  }
  return 0;
}
function formatGoalLength(goal){
  const totalSeconds=goal.end_date>goal.start_date&&goal.start_date>0
    ? Math.max(0,Math.round(goal.end_date-goal.start_date))
    : goal.required_time>0
      ? Math.max(0,Math.round(goal.required_time))
      : 0;
  if(!totalSeconds)return"n/a";

  const days=Math.floor(totalSeconds/86400);
  const hours=Math.floor((totalSeconds%86400)/3600);
  const minutes=Math.floor((totalSeconds%3600)/60);
  const seconds=totalSeconds%60;
  const parts=[];

  if(days)parts.push(`${days}d`);
  if(hours)parts.push(`${hours}h`);
  if(minutes)parts.push(`${minutes}m`);
  if(!parts.length||seconds)parts.push(`${seconds}s`);

  return parts.slice(0,3).join(" ");
}
function formatDurationSeconds(totalSeconds){
  const seconds=Math.max(0,Math.round(Number(totalSeconds)||0));
  if(!seconds)return"0s";

  const days=Math.floor(seconds/86400);
  const hours=Math.floor((seconds%86400)/3600);
  const minutes=Math.floor((seconds%3600)/60);
  const leftoverSeconds=seconds%60;
  const parts=[];

  if(days)parts.push(`${days}d`);
  if(hours)parts.push(`${hours}h`);
  if(minutes)parts.push(`${minutes}m`);
  if(!parts.length||leftoverSeconds)parts.push(`${leftoverSeconds}s`);

  return parts.slice(0,3).join(" ");
}
function closeGoalStructureInspector(){
  $("goal-structure-inspector").classList.remove("is-visible");
  $("goal-structure-inspector").setAttribute("aria-hidden","true");
}
function openGoalStructureInspector(goal){
  if(!goal){
    closeGoalStructureInspector();
    return;
  }
  const rows=[
    ["title",goal.title||"Untitled goal"],
    ["extra info",(goal.extra_info||"No extra info").trim()||"No extra info"],
    ["length",formatGoalLength(goal)],
    ["min pause to next",formatDurationSeconds(goal.min_pause_to_next)],
    ["pause to next",formatDurationSeconds(goal.pause_to_next)]
  ];
  $("goal-structure-inspector-title").textContent=goal.title||"Goal details";
  $("goal-structure-inspector-body").innerHTML=rows.map(([label,value])=>`
    <div class="timeline-inspector__row">
      <div class="timeline-inspector__label">${escapeHtml(label)}</div>
      <div class="timeline-inspector__value">${escapeHtml(value)}</div>
    </div>
  `).join("");
  $("goal-structure-inspector").classList.add("is-visible");
  $("goal-structure-inspector").setAttribute("aria-hidden","false");
}
function formatTimelinePayload(value){
  const text=typeof value==="string"?value.trim():String(value??"");
  if(!text)return "";
  if((text.startsWith("{")&&text.endsWith("}"))||(text.startsWith("[")&&text.endsWith("]"))){
    try{return JSON.stringify(JSON.parse(text),null,2)}catch{return text}
  }
  return text;
}
function timelineInspectorIds(kind){
  return kind==="goal"
    ?{root:"goal-timeline-inspector",kicker:"goal-timeline-inspector-kicker",title:"goal-timeline-inspector-title",body:"goal-timeline-inspector-body"}
    :{root:"timeline-inspector",kicker:"timeline-inspector-kicker",title:"timeline-inspector-title",body:"timeline-inspector-body"};
}
function closeTimelineInspector(kind){
  const ids=timelineInspectorIds(kind);
  const root=$(ids.root);
  if(!root)return;
  root.classList.remove("is-visible");
  root.setAttribute("aria-hidden","true");
}
function openTimelineInspector(kind,hit){
  const ids=timelineInspectorIds(kind);
  const root=$(ids.root);
  if(!root||!hit)return;
  const entry=hit.entry;
  const rows=[
    ["sequence",`#${entry.sequence}`],
    ["type",entry.type||"unknown"],
    ["time",entry.elapsedLabel||""],
    ["session",entry.researchId||(kind==="goal"?L.active:R.active)||""],
    ["payload",formatTimelinePayload(entry.data)]
  ].filter(([,value])=>String(value||"").length>0);
  $(ids.kicker).textContent=kind==="goal"?"Goal Event":"Deep Search Event";
  $(ids.title).textContent=hit.meta.label||entry.type||"Timeline event";
  $(ids.body).innerHTML=rows.map(([label,value])=>`
    <div class="timeline-inspector__row">
      <div class="timeline-inspector__label">${escapeHtml(label)}</div>
      <div class="timeline-inspector__value ${label==="payload"?"timeline-inspector__payload":""}">${escapeHtml(value)}</div>
    </div>
  `).join("");
  root.classList.add("is-visible");
  root.setAttribute("aria-hidden","false");
}
function resetResearchTimelineView(){
  timelineState.cameraX=0;
  timelineState.hoveredNode=null;
  timelineState.selectedNode=null;
  timelineState.isPointerDown=false;
  timelineState.isDragging=false;
  timelineState.pointerId=null;
  timelineState.dragDistance=0;
  timelineState.movedDuringPointer=false;
  closeTimelineInspector("research");
}
function resetGoalTimelineView(){
  goalTimelineState.cameraX=0;
  goalTimelineState.hoveredNode=null;
  goalTimelineState.selectedNode=null;
  goalTimelineState.isPointerDown=false;
  goalTimelineState.isDragging=false;
  goalTimelineState.pointerId=null;
  goalTimelineState.dragDistance=0;
  goalTimelineState.movedDuringPointer=false;
  closeTimelineInspector("goal");
}
function selectResearchSession(sessionId,resetView=false){
  R.active=sessionId||"";
  const session=(R.sessions||[]).find(item=>item.id===R.active);
  if(session)$("research-task").value=session.taskName||"";
  if(resetView)resetResearchTimelineView();
  drawResearchTimeline();
  panels();
}
function selectTimelineNode(hit){
  timelineState.selectedNode=hit||null;
  timelineState.hoveredNode=hit||null;
  if(hit){
    R.detail="Selected.";
    openTimelineInspector("research",hit);
  }else{
    closeTimelineInspector("research");
  }
  panels();
}
function selectGoalTimelineNode(hit){
  goalTimelineState.selectedNode=hit||null;
  goalTimelineState.hoveredNode=hit||null;
  if(hit){
    L.detail="Selected.";
    openTimelineInspector("goal",hit);
  }else{
    closeTimelineInspector("goal");
  }
  panels();
}
function drawInteractiveTimeline(viewState,events,emptyLabel){
  if(viewState===timelineState)resizeTimelineCanvas();
  else resizeGoalTimelineCanvas();
  const ctx=viewState.ctx;
  base(ctx,viewState.width,viewState.height,0,0);
  if(!events.length){
    viewState.positions=[];
    viewState.hoveredNode=null;
    viewState.selectedNode=null;
    viewState.cameraX=0;
    closeTimelineInspector(viewState===goalTimelineState?"goal":"research");
    ctx.fillStyle="#fff";
    ctx.font="740 24px system-ui";
    ctx.textAlign="center";
    ctx.fillText(emptyLabel,viewState.width/2,viewState.height*.48);
    viewState.canvas.style.cursor="grab";
    return;
  }

  viewState.positions=getTimelinePositionsFor(viewState,events);
  const baselineY=Math.round(viewState.height*.56);

  ctx.save();
  ctx.strokeStyle="rgba(255,255,255,0.08)";
  ctx.lineWidth=1;
  ctx.setLineDash([6,10]);
  ctx.beginPath();
  ctx.moveTo(48,baselineY);
  ctx.lineTo(viewState.width-48,baselineY);
  ctx.stroke();
  ctx.restore();

  if(viewState.positions.length>1){
    ctx.save();
    ctx.strokeStyle="rgba(125,211,252,0.32)";
    ctx.lineWidth=1.5;
    ctx.setLineDash([3,8]);
    ctx.beginPath();
    ctx.moveTo(viewState.positions[0].x,viewState.positions[0].y);
    for(let index=1;index<viewState.positions.length;index+=1){
      const prev=viewState.positions[index-1];
      const curr=viewState.positions[index];
      const cpx=(prev.x+curr.x)*.5;
      ctx.bezierCurveTo(cpx,prev.y,cpx,curr.y,curr.x,curr.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.textAlign="center";
  ctx.textBaseline="bottom";
  for(const item of viewState.positions){
    const hovered=viewState.hoveredNode&&viewState.hoveredNode.entry.sequence===item.entry.sequence;
    const selected=viewState.selectedNode&&viewState.selectedNode.entry.sequence===item.entry.sequence;
    const radius=hovered?item.radius+3:selected?item.radius+2:item.radius;

    ctx.save();
    ctx.beginPath();
    ctx.arc(item.x,item.y,radius+10,0,Math.PI*2);
    ctx.fillStyle=selected?"rgba(255,255,255,0.1)":hovered?"rgba(255,255,255,0.08)":"rgba(255,255,255,0.03)";
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(item.x,item.y,radius,0,Math.PI*2);
    ctx.fillStyle="#05070a";
    ctx.fill();
    ctx.strokeStyle=item.meta.accent;
    ctx.lineWidth=selected?4.5:hovered?4:2.5;
    ctx.stroke();

    ctx.fillStyle="#fff";
    ctx.font="700 10px system-ui";
    ctx.textBaseline="middle";
    ctx.fillText(String(item.entry.sequence),item.x,item.y+.5);

    ctx.textBaseline="bottom";
    ctx.font=hovered||selected?"700 12px system-ui":"600 11px system-ui";
    ctx.fillStyle=hovered||selected?"#fff":"rgba(255,255,255,0.72)";
    ctx.fillText(item.meta.label,item.x,item.y-radius-12);
  }
  ctx.restore();
  viewState.canvas.style.cursor=viewState.hoveredNode?"pointer":viewState.isDragging?"grabbing":"grab";
}
function drawResearchTimeline(){drawInteractiveTimeline(timelineState,activeResearch(),"No deep-search events")}
function drawGoalTimeline(){drawInteractiveTimeline(goalTimelineState,activeGoalEvents(),"No goal events")}

function timelinePoint(viewState,event){
  const rect=viewState.canvas.getBoundingClientRect();
  return {x:event.clientX-rect.left,y:event.clientY-rect.top};
}

function handleInteractiveTimelinePointerDown(viewState,event){
  event.preventDefault();
  const {x,y}=timelinePoint(viewState,event);
  viewState.isPointerDown=true;
  viewState.isDragging=false;
  viewState.pointerId=event.pointerId;
  viewState.pointerStartX=x;
  viewState.pointerLastX=x;
  viewState.dragDistance=0;
  viewState.movedDuringPointer=false;
  viewState.mouseX=x;
  viewState.mouseY=y;
  try{viewState.canvas.setPointerCapture(event.pointerId)}catch{}
}

function handleInteractiveTimelinePointerMove(viewState,event,drawFn){
  event.preventDefault();
  const {x,y}=timelinePoint(viewState,event);
  viewState.mouseX=x;
  viewState.mouseY=y;
  if(viewState.isPointerDown){
    const deltaX=x-viewState.pointerLastX;
    viewState.dragDistance+=Math.abs(deltaX);
    if(!viewState.isDragging&&Math.abs(x-viewState.pointerStartX)>4)viewState.isDragging=true;
    if(viewState.isDragging){
      viewState.cameraX+=deltaX;
      viewState.movedDuringPointer=true;
      viewState.hoveredNode=null;
      viewState.canvas.style.cursor="grabbing";
      drawFn();
    }
  }else{
    viewState.hoveredNode=pickTimelineNodeFor(viewState,x,y);
    viewState.canvas.style.cursor=viewState.hoveredNode?"pointer":"grab";
    drawFn();
  }
  viewState.pointerLastX=x;
}

function handleInteractiveTimelinePointerUp(viewState,event,drawFn,onSelect){
  event.preventDefault();
  const {x,y}=timelinePoint(viewState,event);
  const wasDragging=viewState.isDragging;
  try{
    if(viewState.pointerId!==null)viewState.canvas.releasePointerCapture(viewState.pointerId);
  }catch{}
  viewState.isPointerDown=false;
  viewState.isDragging=false;
  viewState.pointerId=null;
  viewState.pointerLastX=x;
  viewState.mouseX=x;
  viewState.mouseY=y;
  if(!wasDragging)onSelect(pickTimelineNodeFor(viewState,x,y));
  viewState.canvas.style.cursor=viewState.hoveredNode?"pointer":"grab";
  drawFn();
}

function handleInteractiveTimelineClick(viewState,event,drawFn,onSelect){
  if(viewState.movedDuringPointer)return;
  const {x,y}=timelinePoint(viewState,event);
  onSelect(pickTimelineNodeFor(viewState,x,y));
  viewState.canvas.style.cursor=viewState.hoveredNode?"pointer":"grab";
  drawFn();
}

function handleInteractiveTimelinePointerLeave(viewState,drawFn){
  if(!viewState.isPointerDown){
    viewState.hoveredNode=null;
    viewState.canvas.style.cursor="grab";
    drawFn();
  }
}

function handleInteractiveTimelinePointerCancel(viewState,drawFn){
  viewState.isPointerDown=false;
  viewState.isDragging=false;
  viewState.pointerId=null;
  viewState.hoveredNode=null;
  viewState.canvas.style.cursor="grab";
  drawFn();
}

function handleTimelinePointerDown(event){
  handleInteractiveTimelinePointerDown(timelineState,event);
}

function handleTimelinePointerMove(event){
  handleInteractiveTimelinePointerMove(timelineState,event,drawResearchTimeline);
}

function handleTimelinePointerUp(event){
  handleInteractiveTimelinePointerUp(timelineState,event,drawResearchTimeline,selectTimelineNode);
}

function handleTimelinePointerLeave(){
  handleInteractiveTimelinePointerLeave(timelineState,drawResearchTimeline);
}

function handleTimelinePointerCancel(){
  handleInteractiveTimelinePointerCancel(timelineState,drawResearchTimeline);
}

function handleTimelineClick(event){
  handleInteractiveTimelineClick(timelineState,event,drawResearchTimeline,selectTimelineNode);
}

function handleGoalTimelinePointerDown(event){
  handleInteractiveTimelinePointerDown(goalTimelineState,event);
}

function handleGoalTimelinePointerMove(event){
  handleInteractiveTimelinePointerMove(goalTimelineState,event,drawGoalTimeline);
}

function handleGoalTimelinePointerUp(event){
  handleInteractiveTimelinePointerUp(goalTimelineState,event,drawGoalTimeline,selectGoalTimelineNode);
}

function handleGoalTimelinePointerLeave(){
  handleInteractiveTimelinePointerLeave(goalTimelineState,drawGoalTimeline);
}

function handleGoalTimelinePointerCancel(){
  handleInteractiveTimelinePointerCancel(goalTimelineState,drawGoalTimeline);
}

function handleGoalTimelineClick(event){
  handleInteractiveTimelineClick(goalTimelineState,event,drawGoalTimeline,selectGoalTimelineNode);
}

function bindTimelineInput(viewState,handlers){
  if(window.PointerEvent){
    viewState.canvas.addEventListener("pointerdown",handlers.down);
    viewState.canvas.addEventListener("pointermove",handlers.move);
    viewState.canvas.addEventListener("pointerup",handlers.up);
    viewState.canvas.addEventListener("pointercancel",handlers.cancel);
    viewState.canvas.addEventListener("pointerleave",handlers.leave);
  }else{
    viewState.canvas.addEventListener("mousedown",handlers.down);
    viewState.canvas.addEventListener("mousemove",handlers.move);
    viewState.canvas.addEventListener("mouseup",handlers.up);
    viewState.canvas.addEventListener("mouseleave",handlers.leave);
  }
  viewState.canvas.addEventListener("click",handlers.click);
}

async function startResearch(event){
  event.preventDefault();
  const taskName=$("research-task").value.trim();
  const minRounds=Math.max(1,parseInt($("research-min-rounds").value||"2",10));
  if(!taskName)return;
  const rid=R.prepared||id("rs");
  const session={id:rid,taskName,minRounds,events:[],status:"Starting",createdAt:Date.now()};
  R.sessions.unshift(session);
  R.active=rid;
  R.busy=true;
  R.detail="Preparing.";
  save("graph-viewer.research-sessions.v5",R.sessions);
  resetResearchTimelineView();
  panels();
  try{
    await connect("research",rid);
    R.detail="Running.";
    panels();
    const response=await fetch(EP.rsStart,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:rid,taskName,minRounds})});
    const text=await response.text();
    if(!response.ok)throw new Error(text||`HTTP ${response.status}`);
    session.status="Completed";
    R.detail="Completed.";
    R.prepared=id("rs");
    await graphView.loadGraph();
  }catch(error){
    session.status="Error";
    R.detail="Error.";
    toast(transport(error),false);
  }finally{
    R.busy=false;
    save("graph-viewer.research-sessions.v5",R.sessions);
    panels();
  }
}

function normGoal(raw){
  return{
    id:String(raw?.id||""),
    globalIndex:Number(raw?.globalIndex||0),
    title:String(raw?.title||"Untitled goal"),
    extra_info:String(raw?.extra_info||""),
    start_date:Number(raw?.start_date||0),
    end_date:Number(raw?.end_date||0),
    required_time:Number(raw?.required_time||0),
    min_pause_to_next:Number(raw?.min_pause_to_next||0),
    pause_to_next:Number(raw?.pause_to_next||0),
    subgoals:Array.isArray(raw?.subgoals)?raw.subgoals.map(Number).filter(Number.isFinite):[],
    parent:Number(raw?.parent||0),
    prev:Number(raw?.prev||0),
    next:Number(raw?.next||0),
    depth:Number(raw?.depth||0)
  };
}

function goalStatus(goal){
  if(goal.end_date>0)return"Finished";
  if(goal.start_date<=0)return"Not started";
  return"Running";
}

async function loadGoals(selectNewest=false){
  L.load=true;
  L.detail="Loading.";
  panels();
  try{
    const response=await fetch(EP.goalList,{cache:"no-store"});
    const raw=await response.json();
    if(!response.ok||raw.ok===false||!Array.isArray(raw.goals))throw new Error(JSON.stringify(raw));
    L.server=raw.goals.map(normGoal).filter(goal=>goal.globalIndex>0).sort((a,b)=>a.globalIndex-b.globalIndex);
    L.byIndex=new Map(L.server.map(goal=>[goal.globalIndex,goal]));
    if(L.server.length)L.selected=selectNewest?L.server.at(-1).globalIndex:(L.byIndex.has(L.selected)?L.selected:L.server[0].globalIndex);
    L.detail="Loaded.";
  }catch(error){
    L.detail="Error.";
    toast(transport(error),false);
  }finally{
    L.load=false;
    panels();
    drawGoals();
  }
}

async function copyGoals(method,url,done,{reload=false}={}){
  if(L.copyBusy)return;
  L.copyBusy=true;
  panels();
  toast(`${method} ${url}`);
  try{
    const response=await fetch(url,{method,cache:"no-store"});
    const text=await response.text();
    let payload=null;
    try{payload=text?JSON.parse(text):null}catch{}
    if(!response.ok||payload?.ok===false)throw new Error(payload?.error||text||`HTTP ${response.status}`);
    toast(done+(payload?.path?`: ${payload.path}`:""),true);
    if(reload)await loadGoals(false);
  }catch(error){
    console.error(error);
    toast(transport(error),false);
  }finally{
    L.copyBusy=false;
    panels();
  }
}

async function createGoal(event){
  event.preventDefault();
  const title=$("goal-title").value.trim();
  const extraInfo=$("goal-extra-info").value.trim();
  if(!title)return;
  const localGoalId=id("goal-pending");
  const goal={id:localGoalId,title,extraInfo,events:[],status:"Creating",createdAt:Date.now()};
  L.items.unshift(goal);
  L.active=localGoalId;
  L.busy=true;
  resetGoalTimelineView();
  save("graph-viewer.goals.v5",L.items);
  panels();
  setGoalPanel("timeline");
  try{
    const response=await fetch(EP.goalCreate,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,extraInfo})});
    const text=await response.text();
    let raw={};
    try{raw=text?JSON.parse(text):{}}catch{}
    if(!response.ok)throw new Error(text||`HTTP ${response.status}`);
    const serverGoalId=String(
      raw?.["goal-id"]||
      raw?.goalId||
      raw?.id||
      raw?.data?.["goal-id"]||
      raw?.data?.goalId||
      raw?.data?.id||
      ""
    ).trim();
    if(serverGoalId){
      goal.id=serverGoalId;
      L.active=serverGoalId;
      recEvent(L,"graph-viewer.goals.v5",{
        id:serverGoalId,
        type:"goal_created",
        data:JSON.stringify({"goal-id":serverGoalId})
      },{});
      save("graph-viewer.goals.v5",L.items);
      panels();
      await connect("goal",serverGoalId);
    }
    goal.status="Created";
    L.detail="Created.";
    await loadGoals(true);
  }catch(error){
    goal.status="Error";
    L.detail="Error.";
    toast(transport(error),false);
  }finally{
    L.busy=false;
    save("graph-viewer.goals.v5",L.items);
    panels();
    drawGoalTimeline();
  }
}

function drawGoals(){
  const canvas=$("goal-structure-canvas");
  const {w,h,c}=resize(canvas);
  base(c,w,h,0,0);
  if(!L.server.length){
    goalStructureState.positions=[];
    goalStructureState.hoveredGoal=null;
    closeGoalStructureInspector();
    syncGoalContextAction(null);
    c.fillStyle="#fff";
    c.font="740 24px system-ui";
    c.textAlign="center";
    c.fillText("No goals loaded",w/2,h*.48);
    return;
  }
  const byParent=new Map();
  for(const goal of L.server){
    if(!byParent.has(goal.parent))byParent.set(goal.parent,[]);
    byParent.get(goal.parent).push(goal);
  }
  const roots=L.focus?[L.byIndex.get(L.focus)].filter(Boolean):(byParent.get(0)||[]);
  const positions=[];
  let row=0;
  function walk(goal,depth){
    const children=byParent.get(goal.globalIndex)||[];
    const start=row;
    if(!children.length)row++;
    else children.forEach(child=>walk(child,depth+1));
    positions.push({goal,x:depth*250,y:((children.length?(start+row-1)/2:start))*100});
  }
  roots.forEach(root=>walk(root,0));
  const mid=(Math.min(...positions.map(point=>point.y))+Math.max(...positions.map(point=>point.y)))/2;
  positions.forEach(point=>{point.y-=mid});
  goalStructureState.positions=positions;
  const map=new Map(positions.map(point=>[point.goal.globalIndex,point]));
  const screen=point=>({x:point.x+goalStructureState.cameraX+w*.28,y:point.y+goalStructureState.cameraY+h*.54});
  const hoveredIndex=goalStructureState.hoveredGoal?.globalIndex||0;
  let selectedPoint=null;
  c.lineCap="round";

  c.save();
  c.setLineDash([5,9]);
  for(const point of positions){
    if(!point.goal.next)continue;
    const target=map.get(point.goal.next);
    if(!target)continue;
    const a=screen(point);
    const b=screen(target);
    const linkedHover=point.goal.globalIndex===hoveredIndex||target.goal.globalIndex===hoveredIndex;
    const sameDepth=Math.abs(a.x-b.x)<4;
    const bend=sameDepth?Math.max(36,Math.abs(a.y-b.y)*.28):0;
    c.strokeStyle=linkedHover?"rgba(255,255,255,.28)":"rgba(255,255,255,.13)";
    c.lineWidth=linkedHover?1.4:1;
    c.beginPath();
    if(sameDepth){
      const side=Math.sign(b.y-a.y)||1;
      c.moveTo(a.x+34,a.y);
      c.bezierCurveTo(a.x+72+side*bend,a.y,a.x+72+side*bend,b.y,b.x+34,b.y);
    }else{
      c.moveTo(a.x,a.y);
      c.bezierCurveTo((a.x+b.x)/2,a.y,(a.x+b.x)/2,b.y,b.x,b.y);
    }
    c.stroke();
  }
  c.restore();

  for(const point of positions){
    for(const childId of point.goal.subgoals){
      const target=map.get(childId);
      if(!target)continue;
      const a=screen(point);
      const b=screen(target);
      const linkedHover=point.goal.globalIndex===hoveredIndex||target.goal.globalIndex===hoveredIndex;
      c.strokeStyle=linkedHover?"rgba(125,211,252,.4)":"rgba(125,211,252,.24)";
      c.lineWidth=linkedHover?2.2:1.4;
      c.beginPath();
      c.moveTo(a.x,a.y);
      c.bezierCurveTo((a.x+b.x)/2,a.y,(a.x+b.x)/2,b.y,b.x,b.y);
      c.stroke();
    }
  }
  for(const point of positions){
    const s=screen(point);
    const selected=point.goal.globalIndex===L.selected;
    const hovered=point.goal.globalIndex===hoveredIndex;
    const co=color(point.goal.globalIndex);
    const radius=selected?32:hovered?30:28;
    if(selected||hovered){
      c.beginPath();
      c.arc(s.x,s.y,radius+10,0,Math.PI*2);
      c.fillStyle=selected?"rgba(255,255,255,.11)":"rgba(255,255,255,.07)";
      c.fill();
    }
    c.beginPath();
    c.arc(s.x,s.y,radius,0,Math.PI*2);
    c.fillStyle="#05070a";
    c.fill();
    c.strokeStyle=co;
    c.lineWidth=selected?4.6:hovered?3.2:2.2;
    c.stroke();
    c.fillStyle="#fff";
    c.font=selected||hovered?"740 12px system-ui":"740 11px system-ui";
    c.textAlign="center";
    c.fillText(String(point.goal.globalIndex),s.x,s.y+4);
    c.font=selected||hovered?"650 12px system-ui":"650 11px system-ui";
    c.fillText(point.goal.title.slice(0,36),s.x,s.y+46);
    if(selected)selectedPoint={goal:point.goal,x:s.x,y:s.y,hasChildren:point.goal.subgoals.length>0};
  }
  canvas.style.cursor=goalStructureState.dragging?"grabbing":goalStructureState.hoveredGoal?"pointer":"grab";
  syncGoalContextAction(selectedPoint);
}

function syncGoalContextAction(point=null){
  const button=$("decompose-selected-goal");
  if(!button)return;
  const canShow=Boolean(point)&&L.mode!=="timeline"&&!L.decomp&&!point.hasChildren&&!point.goal.end_date&&L.selected===point.goal.globalIndex;
  if(!canShow){
    button.disabled=true;
    button.classList.remove("is-visible");
    button.setAttribute("aria-hidden","true");
    return;
  }
  const rect=goalStructureState.canvas.getBoundingClientRect();
  button.style.left=`${Math.round(point.x)}px`;
  button.style.top=`${Math.round(Math.max(18,point.y-44))}px`;
  button.disabled=false;
  button.classList.add("is-visible");
  button.setAttribute("aria-hidden","false");
  button.style.maxWidth=`${Math.max(96,Math.min(240,rect.width-24))}px`;
}

async function decomposeGoal(){
  const goal=L.byIndex.get(L.selected);
  if(!goal){
    L.detail="Ready.";
    toast("Select a goal first.",false);
    panels();
    return;
  }
  if(goal.end_date){
    L.detail="Ready.";
    toast("Cannot decompose a completed goal.",false);
    panels();
    return;
  }
  L.decomp=true;
  L.detail="Decomposing.";
  syncGoalContextAction(null);
  panels();
  try{
    const response=await fetch(EP.goalDecompose,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({goalIndex:goal.globalIndex})});
    const raw=await response.json();
    if(!response.ok||raw.ok===false)throw new Error(JSON.stringify(raw));
    L.detail=raw.decomposedNow?"Decomposed.":"Children loaded.";
    $("decompose-selected-goal").disabled=true;
    await loadGoals(false);
  }catch(error){
    L.detail="Error.";
    toast(transport(error),false);
  }finally{
    L.decomp=false;
    panels();
    drawGoals();
  }
}

function goalStructurePoint(event){
  const rect=goalStructureState.canvas.getBoundingClientRect();
  return {x:event.clientX-rect.left,y:event.clientY-rect.top};
}

function pickGoalAt(x,y,w,h){
  let hit=null;
  for(const point of goalStructureState.positions){
    const sx=point.x+goalStructureState.cameraX+w*.28;
    const sy=point.y+goalStructureState.cameraY+h*.54;
    if(Math.hypot(x-sx,y-sy)<44)hit=point.goal;
  }
  return hit;
}

function resetGoalFocus(clearSelection=false){
  L.focus=0;
  goalStructureState.cameraX=0;
  goalStructureState.cameraY=0;
  goalStructureState.hoveredGoal=null;
  if(clearSelection)L.selected=0;
  closeGoalStructureInspector();
  panels();
  drawGoals();
}

function handleGoalStructurePointerDown(event){
  if(L.mode==="timeline")return;
  const {x,y}=goalStructurePoint(event);
  goalStructureState.pointerDown=true;
  goalStructureState.dragging=false;
  goalStructureState.pointerId=event.pointerId;
  goalStructureState.startX=x;
  goalStructureState.startY=y;
  goalStructureState.lastX=x;
  goalStructureState.lastY=y;
  goalStructureState.moved=false;
  try{goalStructureState.canvas.setPointerCapture(event.pointerId)}catch{}
}

function handleGoalStructurePointerMove(event){
  if(L.mode==="timeline")return;
  const {w,h}=resize(goalStructureState.canvas);
  const {x,y}=goalStructurePoint(event);
  if(goalStructureState.pointerDown){
    const dx=x-goalStructureState.lastX;
    const dy=y-goalStructureState.lastY;
    if(!goalStructureState.dragging&&(Math.abs(x-goalStructureState.startX)>4||Math.abs(y-goalStructureState.startY)>4))goalStructureState.dragging=true;
    if(goalStructureState.dragging){
      goalStructureState.cameraX+=dx;
      goalStructureState.cameraY+=dy;
      goalStructureState.moved=true;
      goalStructureState.hoveredGoal=null;
      drawGoals();
    }
  }else{
    goalStructureState.hoveredGoal=pickGoalAt(x,y,w,h);
    drawGoals();
  }
  goalStructureState.lastX=x;
  goalStructureState.lastY=y;
}

function handleGoalStructurePointerUp(event){
  if(L.mode==="timeline")return;
  const {w,h}=resize(goalStructureState.canvas);
  const {x,y}=goalStructurePoint(event);
  const wasDragging=goalStructureState.dragging;
  try{
    if(goalStructureState.pointerId!==null)goalStructureState.canvas.releasePointerCapture(goalStructureState.pointerId);
  }catch{}
  goalStructureState.pointerDown=false;
  goalStructureState.dragging=false;
  goalStructureState.pointerId=null;
  if(!wasDragging){
    const hit=pickGoalAt(x,y,w,h);
    if(hit){
      selectGoal(hit.globalIndex,{focus:false});
      goalStructureState.hoveredGoal=hit;
      openGoalStructureInspector(hit);
    }else if(L.focus){
      resetGoalFocus(false);
      return;
    }else{
      L.selected=0;
      closeGoalStructureInspector();
      panels();
    }
  }
  drawGoals();
}

function handleGoalStructureDoubleClick(event){
  if(L.mode==="timeline")return;
  const {w,h}=resize(goalStructureState.canvas);
  const {x,y}=goalStructurePoint(event);
  const hit=pickGoalAt(x,y,w,h);
  if(hit){
    selectGoal(hit.globalIndex,{focus:true});
    goalStructureState.hoveredGoal=hit;
    openGoalStructureInspector(hit);
  }
}

function handleGoalStructurePointerLeave(){
  if(goalStructureState.pointerDown)return;
  goalStructureState.hoveredGoal=null;
  drawGoals();
}

function handleGoalStructurePointerCancel(){
  goalStructureState.pointerDown=false;
  goalStructureState.dragging=false;
  goalStructureState.pointerId=null;
  goalStructureState.hoveredGoal=null;
  drawGoals();
}

function setGoalPanel(mode){
  L.mode=mode;
  $("goal-structure-panel").classList.toggle("is-active",mode!=="timeline");
  $("goal-timeline-panel").classList.toggle("is-active",mode==="timeline");
  $("goal-structure-mode").classList.toggle("is-active",mode!=="timeline");
  $("goal-timeline-mode").classList.toggle("is-active",mode==="timeline");
  mode==="timeline"?drawGoalTimeline():drawGoals();
}

function setView(view){
  $("graph-view").classList.toggle("is-active",view==="graph");
  $("deep-search-view").classList.toggle("is-active",view==="ds");
  $("goal-view").classList.toggle("is-active",view==="goal");
  $("graph-view-toggle").classList.toggle("is-active",view==="graph");
  $("deep-search-view-toggle").classList.toggle("is-active",view==="ds");
  $("goal-view-toggle").classList.toggle("is-active",view==="goal");
  graphView.setActive(view==="graph");
  if(view==="ds")drawResearchTimeline();
  if(view==="goal"){
    loadGoals(false);
    (L.mode==="timeline"?drawGoalTimeline:drawGoals)();
  }
}

async function submitMsg(event){
  event.preventDefault();
  const input=$("message-input").value.trim();
  if(!input)return;
  $("message-panel-status").textContent=`POST ${EP.msg}`;
  $("submit-message").disabled=true;
  try{
    const response=await fetch(EP.msg,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({input})});
    const text=await response.text();
    if(!response.ok)throw new Error(text||`HTTP ${response.status}`);
    $("message-panel-status").textContent="Accepted. Refreshing graph.";
    $("message-input").value="";
    toast("Message sent");
    await graphView.loadGraph();
  }catch(error){
    const message=transport(error);
    $("message-panel-status").textContent=message;
    toast(message,false);
  }finally{
    $("submit-message").disabled=false;
    $("message-input").focus();
  }
}

async function submitEndpoint(event){
  event.preventDefault();
  const nextValue=$("endpoint-base-input").value.trim();
  $("apply-endpoint").disabled=true;
  $("reset-endpoint").disabled=true;
  try{
    await applyEndpointChange(nextValue,{reloadGraph:true});
    toast("Server endpoint updated");
  }catch(error){
    const message=transport(error);
    syncEndpointUi(message,false);
    toast(message,false);
  }finally{
    $("apply-endpoint").disabled=false;
    $("reset-endpoint").disabled=endpointBase===defaultEndpointBase();
  }
}

$("graph-confirm-cancel").onclick=()=>closeConfirm(false);
$("graph-confirm-accept").onclick=()=>closeConfirm(true);
$("graph-confirm-backdrop").addEventListener("click",event=>{if(event.target===$("graph-confirm-backdrop"))closeConfirm(false)});
$("timeline-inspector-close").onclick=()=>closeTimelineInspector("research");
$("goal-structure-inspector-close").onclick=()=>closeGoalStructureInspector();
$("goal-timeline-inspector-close").onclick=()=>closeTimelineInspector("goal");
$("timeline-inspector").addEventListener("pointerdown",event=>event.stopPropagation());
$("goal-structure-inspector").addEventListener("pointerdown",event=>event.stopPropagation());
$("goal-timeline-inspector").addEventListener("pointerdown",event=>event.stopPropagation());
addEventListener("keydown",event=>{
  if(event.key!=="Escape")return;
  if(confirmState.resolve)closeConfirm(false);
  else if($("timeline-inspector").classList.contains("is-visible"))closeTimelineInspector("research");
  else if($("goal-structure-inspector").classList.contains("is-visible"))closeGoalStructureInspector();
  else if($("goal-timeline-inspector").classList.contains("is-visible"))closeTimelineInspector("goal");
  else if(graphView.onEscape())return;
});
$("message-form").onsubmit=submitMsg;
$("message-panel").addEventListener("pointerdown",event=>event.stopPropagation());
$("message-panel").addEventListener("mousedown",event=>event.stopPropagation());
$("message-input").addEventListener("keydown",event=>{
  if(event.key==="Enter"){
    event.preventDefault();
    $("message-form").requestSubmit();
  }
});
$("endpoint-form").onsubmit=submitEndpoint;
$("endpoint-form").addEventListener("pointerdown",event=>event.stopPropagation());
$("endpoint-form").addEventListener("mousedown",event=>event.stopPropagation());
$("reset-endpoint").onclick=async()=>{
  $("apply-endpoint").disabled=true;
  $("reset-endpoint").disabled=true;
  try{
    await applyEndpointChange(defaultEndpointBase(),{reloadGraph:true});
    toast("Server endpoint reset");
  }catch(error){
    const message=transport(error);
    syncEndpointUi(message,false);
    toast(message,false);
  }finally{
    $("apply-endpoint").disabled=false;
    $("reset-endpoint").disabled=endpointBase===defaultEndpointBase();
  }
};
$("endpoint-base-input").addEventListener("keydown",event=>{
  if(event.key==="Enter"){
    event.preventDefault();
    $("endpoint-form").requestSubmit();
  }
});
$("research-form").onsubmit=startResearch;
$("research-task").oninput=panels;
$("research-form").addEventListener("pointerdown",event=>event.stopPropagation());
$("research-form").addEventListener("mousedown",event=>event.stopPropagation());
$("new-research-session").onclick=()=>{R.active=R.prepared=id("rs");$("research-task").value="";R.detail="Ready.";resetResearchTimelineView();drawResearchTimeline();panels()};
$("clear-research-history").onclick=()=>{R.sessions=[];R.active="";R.detail="Ready.";save("graph-viewer.research-sessions.v5",R.sessions);resetResearchTimelineView();drawResearchTimeline();panels()};
$("graph-view-toggle").onclick=()=>setView("graph");
$("deep-search-view-toggle").onclick=()=>setView("ds");
$("goal-view-toggle").onclick=()=>setView("goal");
bindTimelineInput(timelineState,{
  down:handleTimelinePointerDown,
  move:handleTimelinePointerMove,
  up:handleTimelinePointerUp,
  cancel:handleTimelinePointerCancel,
  leave:handleTimelinePointerLeave,
  click:handleTimelineClick
});
bindTimelineInput(goalTimelineState,{
  down:handleGoalTimelinePointerDown,
  move:handleGoalTimelinePointerMove,
  up:handleGoalTimelinePointerUp,
  cancel:handleGoalTimelinePointerCancel,
  leave:handleGoalTimelinePointerLeave,
  click:handleGoalTimelineClick
});
addEventListener("resize",()=>{graphView.renderGraph();drawResearchTimeline();drawGoalTimeline();drawGoals()});

function initGoalView(){
  $("goal-form").onsubmit=createGoal;
  $("goal-title").oninput=panels;
  $("goal-extra-info").oninput=panels;
  $("goal-form").addEventListener("pointerdown",event=>event.stopPropagation());
  $("goal-form").addEventListener("mousedown",event=>event.stopPropagation());
  $("refresh-goals").onclick=()=>loadGoals(false);
  $("refresh-goals-sidebar").onclick=()=>loadGoals(false);
  $("save-goals-copy").onclick=async()=>{if(await confirmGraphAction("Save goals copy?","This will overwrite the saved goals copy on disk. Continue only if this is intentional.","Save copy"))copyGoals("POST",EP.goalExport,"Goals copy saved")};
  $("load-goals-copy").onclick=async()=>{if(await confirmGraphAction("Load saved goals copy?","This will replace the current in-memory goals with the saved copy. Unsaved current goal state may be lost.","Load copy"))copyGoals("GET",EP.goalLoad,"Goals copy loaded",{reload:true})};
  $("decompose-selected-goal").onclick=decomposeGoal;
  $("decompose-selected-goal").addEventListener("pointerdown",event=>event.stopPropagation());
  $("decompose-selected-goal").addEventListener("mousedown",event=>event.stopPropagation());
  $("goal-structure-mode").onclick=()=>setGoalPanel("structure");
  $("goal-timeline-mode").onclick=()=>setGoalPanel("timeline");
  $("clear-goal-history").onclick=()=>{L.items=[];L.active="";L.detail="Ready.";closeGoalStructureInspector();save("graph-viewer.goals.v5",L.items);resetGoalTimelineView();drawGoalTimeline();panels()};
  goalStructureState.canvas.addEventListener("pointerdown",handleGoalStructurePointerDown);
  goalStructureState.canvas.addEventListener("pointermove",handleGoalStructurePointerMove);
  goalStructureState.canvas.addEventListener("pointerup",handleGoalStructurePointerUp);
  goalStructureState.canvas.addEventListener("pointerleave",handleGoalStructurePointerLeave);
  goalStructureState.canvas.addEventListener("pointercancel",handleGoalStructurePointerCancel);
  goalStructureState.canvas.addEventListener("dblclick",handleGoalStructureDoubleClick);
}

  try{
    syncEndpointUi(`Using ${endpointBase}`,true);
    panels();
    drawResearchTimeline();
    drawGoalTimeline();
    drawGoals();
  }catch(error){
    console.error("Non-graph panel init failed",error);
  }

  try{
    initGoalView();
    loadGoals(false);
  }catch(error){
    console.error("Goal view init failed",error);
    L.detail="Goal view unavailable.";
  }
timelineState.canvas.style.cursor="grab";
goalTimelineState.canvas.style.cursor="grab";

(function(){
  const app=document.querySelector(".app");
  const btn=$("sidebar-toggle");
  const hidden=localStorage.getItem("sidebar-hidden")==="1";
  if(hidden)app.classList.add("sidebar-hidden");
  btn.classList.toggle("is-active",hidden);
  btn.onclick=()=>{
    const isHidden=app.classList.toggle("sidebar-hidden");
    btn.classList.toggle("is-active",isHidden);
    try{localStorage.setItem("sidebar-hidden",isHidden?"1":"0")}catch{}
  };
}());
