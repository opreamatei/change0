import {$,clamp,num,own,resize,base,color} from "./shared.js";

const EDGE_TOLERANCE_PX=10;
const DRAG_THRESHOLD_PX=4;
const GROUP_GLOW_PADDING=26;
const GRAPH_ACCENT="#7dd3fc";

function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}

export function createGraphView({endpoints,transport,toast,confirmAction}){
  const state={
    canvas:$("graph"),
    ctx:$("graph").getContext("2d"),
    nodes:[],
    edges:[],
    roots:[],
    byId:new Map(),
    children:new Map(),
    visible:[],
    vedges:[],
    groups:[],
    focus:[],
    selectedNode:null,
    selectedEdge:null,
    hoverNode:null,
    hoverEdge:null,
    hoverGroup:null,
    loading:true,
    error:null,
    explode:false,
    active:true,
    cam:{x:0,y:0,s:1},
    pointer:{down:false,drag:false,x:0,y:0,startX:0,startY:0,id:null,mode:"camera",node:null,edge:null,group:null,target:null,targetType:"background"},
    copyBusy:false,
    last:performance.now(),
    w:0,
    h:0,
    orbitRadiusCurrent:0,
    orbitRadiusTarget:0
  };

  const orbitRoot=$("graph-orbit");

  function metricUnit(value){return clamp((num(value,1)-.75)/.75,0,1)}
  function metricText(value){const rounded=Math.round(num(value,0)*100)/100;return Number.isInteger(rounded)?String(rounded):String(rounded)}
  function nodeRadius(node){return clamp(18+metricUnit(node.activation)*4+metricUnit(node.weight)*3,18,30)}
  function nodeStrokeWidth(node){return 2.2+metricUnit(node.weight)*2.1}
  function edgeScreenWidth(edge,extra=0){return clamp((1.05+metricUnit(edge.weight)*2.2+extra)*state.cam.s,.9,5.2)}
  function edgeHitToleranceWorld(edge){const px=clamp(EDGE_TOLERANCE_PX+metricUnit(edge.weight)*2,8,12)+edgeScreenWidth(edge)*.5;return px/Math.max(state.cam.s,.001)}
  function w2s(x,y){return{x:(x-state.cam.x)*state.cam.s+state.w*.5,y:(y-state.cam.y)*state.cam.s+state.h*.5}}
  function s2w(x,y){return{x:state.cam.x+(x-state.w*.5)/state.cam.s,y:state.cam.y+(y-state.h*.5)/state.cam.s}}

  function updateGraphControls(){
    const hasNodes=state.nodes.length>0;
    const canGoDeeper=currentParents().some(node=>(state.children.get(node.id)||[]).length);
    $("refresh-graph").disabled=state.loading;
    $("save-graph-copy").disabled=state.copyBusy||state.loading;
    $("load-graph-copy").disabled=state.copyBusy;
    $("explode-toggle").disabled=state.loading||state.error||!hasNodes||(!state.explode&&!canGoDeeper);
    $("explode-toggle").classList.toggle("is-active",state.explode);
  }

  function focusBadge(){
    const badge=$("focus-node");
    if(state.selectedEdge){
      badge.classList.add("is-visible");
      badge.style.color=GRAPH_ACCENT;
      $("focus-node-ring").style.borderColor=GRAPH_ACCENT;
      $("focus-node-label").textContent=`${state.selectedEdge.a.name} -> ${state.selectedEdge.b.name}`;
      return;
    }
    const node=state.selectedNode||state.focus[state.focus.length-1];
    if(!node){
      badge.classList.remove("is-visible");
      return;
    }
    badge.classList.add("is-visible");
    badge.style.color=node.color;
    $("focus-node-ring").style.borderColor=node.color;
    $("focus-node-label").textContent=node.name;
  }

  function selectionOrbitRows(){
    if(state.selectedNode){
      const node=state.selectedNode;
      return [
        {label:"name",value:node.name},
        {label:"id",value:`#${node.id}`},
        {label:"activation",value:metricText(node.activation)},
        {label:"weight",value:metricText(node.weight)},
        {label:"children",value:String(node.children||0)}
      ];
    }
    if(state.selectedEdge){
      const edge=state.selectedEdge;
      return [
        {label:"source",value:edge.a.name},
        {label:"target",value:edge.b.name},
        {label:"activation",value:metricText(edge.activation)},
        {label:"weight",value:metricText(edge.weight)}
      ];
    }
    return [];
  }

  function updateSelectionOrbit(){
    const rows=selectionOrbitRows();
    if(!state.active||!rows.length){
      state.orbitRadiusCurrent=0;
      state.orbitRadiusTarget=0;
      orbitRoot.innerHTML="";
      orbitRoot.setAttribute("aria-hidden","true");
      return;
    }
    const center=state.selectedNode
      ? w2s(state.selectedNode.x,state.selectedNode.y)
      : w2s((state.selectedEdge.a.x+state.selectedEdge.b.x)/2,(state.selectedEdge.a.y+state.selectedEdge.b.y)/2);
    const baseRadius=state.selectedNode?state.selectedNode.r*state.cam.s+86.4:105.6;
    state.orbitRadiusTarget=baseRadius;
    if(state.orbitRadiusCurrent===0)state.orbitRadiusCurrent=baseRadius*.72;
    state.orbitRadiusCurrent+=(state.orbitRadiusTarget-state.orbitRadiusCurrent)*.18;
    orbitRoot.setAttribute("aria-hidden","false");
    orbitRoot.innerHTML=rows.map((row,index)=>{
      const angle=-Math.PI/2+index*(Math.PI*2/rows.length);
      const x=center.x+Math.cos(angle)*state.orbitRadiusCurrent;
      const y=center.y+Math.sin(angle)*state.orbitRadiusCurrent;
      return `<div class="graph-orbit__item is-visible" style="left:${x}px;top:${y}px"><div class="graph-orbit__label">${escapeHtml(row.label)}</div><div class="graph-orbit__value">${escapeHtml(row.value)}</div></div>`;
    }).join("");
  }

  function refreshPanels(){
    focusBadge();
    updateSelectionOrbit();
  }

  function parseGraph(raw){
    const nodes=[];
    const byId=new Map();
    for(const item of raw.nodes||[]){
      const node={
        id:Number(item.id),
        name:typeof item.name==="string"?item.name:String(item.id),
        activation:num(item.activation,1),
        weight:num(item.weight,1),
        hasParent:own(item,"parent"),
        parentId:own(item,"parent")?Number(item.parent):null,
        x:0,
        y:0,
        vx:0,
        vy:0,
        color:null,
        r:0,
        children:0,
        seed:((Number(item.id)*9301+49297)%233280)/233280
      };
      if(!Number.isFinite(node.id)||byId.has(node.id))continue;
      node.r=nodeRadius(node);
      nodes.push(node);
      byId.set(node.id,node);
    }
    nodes.sort((a,b)=>a.id-b.id);

    const children=new Map();
    for(const node of nodes){
      if(!node.hasParent||!Number.isFinite(node.parentId))continue;
      if(!children.has(node.parentId))children.set(node.parentId,[]);
      children.get(node.parentId).push(node);
    }
    for(const branch of children.values())branch.sort((a,b)=>a.id-b.id);

    function resolveColor(node,seen=new Set()){
      if(node.color)return node.color;
      if(seen.has(node.id)||!node.hasParent)return node.color=color(node.id);
      seen.add(node.id);
      const parent=byId.get(node.parentId);
      return node.color=parent?resolveColor(parent,seen):color(node.id);
    }

    nodes.forEach(node=>{
      resolveColor(node);
      node.children=(children.get(node.id)||[]).length;
    });

    const edges=[];
    for(const connection of raw.connections||[]){
      if(!connection||!Array.isArray(connection.nodes)||connection.nodes.length!==2)continue;
      const a=byId.get(Number(connection.nodes[0]));
      const b=byId.get(Number(connection.nodes[1]));
      if(!a||!b||a===b)continue;
      edges.push({a,b,weight:num(connection.weight,1),activation:num(connection.activation,1)});
    }

    Object.assign(state,{
      nodes,
      byId,
      children,
      edges,
      roots:nodes.filter(node=>node.hasParent===false),
      focus:[],
      selectedNode:null,
      selectedEdge:null,
      hoverNode:null,
      hoverEdge:null,
      hoverGroup:null
    });
  }

  function currentParents(){
    const focused=state.focus[state.focus.length-1];
    return focused?(state.children.get(focused.id)||[]):state.roots;
  }

  function seed(nodes,cx=0,cy=0,spread=null){
    const goldenAngle=Math.PI*(3-Math.sqrt(5));
    nodes.forEach((node,index)=>{
      const distance=nodes.length===1?0:Math.min((spread?clamp(spread*.22,26,42):56)*Math.sqrt(index+.45),spread??Infinity);
      const angle=nodes.length===1?-Math.PI*.5:index*goldenAngle+node.seed*.75;
      node.x=cx+Math.cos(angle)*distance;
      node.y=cy+Math.sin(angle)*distance;
      node.vx=0;
      node.vy=0;
    });
  }

  function syncVisibleNodeMetrics(){
    for(const node of state.visible)node.r=nodeRadius(node);
  }

  function refreshGroupGeometry(){
    for(const group of state.groups){
      let maxDistance=24;
      for(const node of group.members){
        maxDistance=Math.max(maxDistance,Math.hypot(node.x-group.x,node.y-group.y)+node.r);
      }
      group.r=maxDistance+GROUP_GLOW_PADDING;
    }
  }

  function recompute(){
    const parents=currentParents();
    if(state.explode){
      state.groups=parents.map(parent=>({
        parent,
        members:state.children.get(parent.id)||[],
        x:0,
        y:0,
        r:0,
        color:parent.color
      })).filter(group=>group.members.length);
      state.visible=state.groups.flatMap(group=>group.members);
      const ringRadius=clamp(140+state.groups.length*32,180,420);
      state.groups.forEach((group,index)=>{
        const angle=-Math.PI/2+Math.PI*2*index/Math.max(1,state.groups.length);
        group.x=Math.cos(angle)*ringRadius;
        group.y=Math.sin(angle)*ringRadius*.72;
        seed(group.members,group.x,group.y,120);
      });
    }else{
      state.groups=[];
      state.visible=parents.slice();
      seed(state.visible);
    }

    syncVisibleNodeMetrics();
    refreshGroupGeometry();

    const visibleIds=new Set(state.visible.map(node=>node.id));
    state.vedges=state.edges.filter(edge=>visibleIds.has(edge.a.id)&&visibleIds.has(edge.b.id));
    state.cam={x:0,y:0,s:state.explode?.72:.96};
    state.hoverNode=null;
    state.hoverEdge=null;
    state.hoverGroup=null;
    state.selectedNode=null;
    state.selectedEdge=null;
    updateGraphControls();
    refreshPanels();
    graphCursor();
  }

  function pointToSegmentDistance(point,a,b){
    const dx=b.x-a.x;
    const dy=b.y-a.y;
    if(!dx&&!dy)return Math.hypot(point.x-a.x,point.y-a.y);
    const t=clamp(((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy),0,1);
    const px=a.x+dx*t;
    const py=a.y+dy*t;
    return Math.hypot(point.x-px,point.y-py);
  }

  function pickNode(x,y){
    const worldPoint=s2w(x,y);
    for(let i=state.visible.length-1;i>=0;i--){
      const node=state.visible[i];
      if(Math.hypot(worldPoint.x-node.x,worldPoint.y-node.y)<=node.r+8/state.cam.s)return node;
    }
    return null;
  }

  function pickEdge(x,y){
    if(!state.vedges.length)return null;
    const worldPoint=s2w(x,y);
    let bestEdge=null;
    let bestDistance=Infinity;
    for(let i=state.vedges.length-1;i>=0;i--){
      const edge=state.vedges[i];
      const distance=pointToSegmentDistance(worldPoint,edge.a,edge.b);
      if(distance>edgeHitToleranceWorld(edge)||distance>=bestDistance)continue;
      bestDistance=distance;
      bestEdge=edge;
    }
    return bestEdge;
  }

  function pickGroup(x,y){
    if(!state.groups.length)return null;
    const worldPoint=s2w(x,y);
    for(let i=state.groups.length-1;i>=0;i--){
      const group=state.groups[i];
      if(Math.hypot(worldPoint.x-group.x,worldPoint.y-group.y)<=group.r)return group;
    }
    return null;
  }

  function clearSelection(){
    state.selectedNode=null;
    state.selectedEdge=null;
    state.orbitRadiusCurrent=0;
    state.orbitRadiusTarget=0;
    refreshPanels();
  }

  function selectNode(node){
    state.selectedNode=node;
    state.selectedEdge=null;
    state.orbitRadiusCurrent=0;
    refreshPanels();
  }

  function selectEdge(edge){
    state.selectedNode=null;
    state.selectedEdge=edge;
    state.orbitRadiusCurrent=0;
    refreshPanels();
  }

  function handleNodeSelection(node){
    const shouldFocus=state.selectedNode===node&&!state.selectedEdge&&node.children>0;
    selectNode(node);
    if(shouldFocus){
      state.focus.push(node);
      state.explode=false;
      recompute();
    }
  }

  function handleGroupSelection(group){
    if(group?.parent)handleNodeSelection(group.parent);
  }

  function handleBackgroundSelection(){
    clearSelection();
    if(state.focus.length){
      state.focus.pop();
      state.explode=false;
      recompute();
      return;
    }
    if(state.explode){
      state.explode=false;
      recompute();
    }
  }

  function handlePointerClick(targetType,target){
    if(targetType==="node"&&target)return handleNodeSelection(target);
    if(targetType==="edge"&&target)return selectEdge(target);
    if(targetType==="group"&&target)return handleGroupSelection(target);
    handleBackgroundSelection();
  }

  function graphPoint(event){
    const rect=state.canvas.getBoundingClientRect();
    return{x:event.clientX-rect.left,y:event.clientY-rect.top};
  }

  function graphCursor(){
    if(state.pointer.down&&state.pointer.drag){
      state.canvas.style.cursor="grabbing";
      return;
    }
    if(state.hoverNode||state.hoverEdge){
      state.canvas.style.cursor="pointer";
      return;
    }
    state.canvas.style.cursor="grab";
  }

  function graphHoverAt(x,y){
    const node=pickNode(x,y);
    const edge=node?null:pickEdge(x,y);
    state.hoverNode=node;
    state.hoverEdge=edge;
    state.hoverGroup=node||edge?null:pickGroup(x,y);
    graphCursor();
  }

  function step(dt){
    const nodes=state.visible;
    if(!nodes.length){
      refreshGroupGeometry();
      return;
    }

    syncVisibleNodeMetrics();

    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i];
      const b=nodes[j];
      let dx=b.x-a.x;
      let dy=b.y-a.y;
      if(!dx&&!dy){dx=.01;dy=.01}
      const distanceSquared=Math.max(dx*dx+dy*dy,.01);
      const distance=Math.sqrt(distanceSquared);
      const nx=dx/distance;
      const ny=dy/distance;
      const repel=2400/distanceSquared*dt;
      a.vx-=nx*repel;
      a.vy-=ny*repel;
      b.vx+=nx*repel;
      b.vy+=ny*repel;
      const minDistance=a.r+b.r+12;
      if(distance<minDistance){
        const push=(minDistance-distance)*.18;
        a.x-=nx*push;a.y-=ny*push;b.x+=nx*push;b.y+=ny*push;
      }
    }

    for(const edge of state.vedges){
      const dx=edge.b.x-edge.a.x;
      const dy=edge.b.y-edge.a.y;
      const distance=Math.max(Math.hypot(dx,dy),.01);
      const nx=dx/distance;
      const ny=dy/distance;
      const desired=clamp(edge.a.r+edge.b.r+18+clamp(edge.activation,.1,5)*7,66,180);
      const spring=(distance-desired)*.0036*clamp(edge.weight,.1,5)*dt;
      edge.a.vx+=nx*spring;
      edge.a.vy+=ny*spring;
      edge.b.vx-=nx*spring;
      edge.b.vy-=ny*spring;
    }

    for(const group of state.groups)for(const node of group.members){
      node.vx+=(group.x-node.x)*.0065*dt;
      node.vy+=(group.y-node.y)*.0065*dt;
    }

    for(const node of nodes){
      if(!state.explode){
        node.vx+=-node.x*.004*dt;
        node.vy+=-node.y*.004*dt;
      }
      node.vx*=.88;
      node.vy*=.88;
      node.x+=node.vx*dt;
      node.y+=node.vy*dt;
    }

    refreshGroupGeometry();
  }

  function renderGraph(){
    const resized=resize(state.canvas);
    Object.assign(state,{w:resized.w,h:resized.h,ctx:resized.c});
    base(state.ctx,state.w,state.h,state.cam.x*state.cam.s,state.cam.y*state.cam.s);
    if(state.loading||state.error){
      state.ctx.fillStyle="#fff";
      state.ctx.font="650 18px system-ui";
      state.ctx.textAlign="center";
      state.ctx.fillText(state.loading?"Loading graph":state.error,state.w/2,state.h/2);
      updateSelectionOrbit();
      return;
    }

    const ctx=state.ctx;
    for(const group of state.groups){
      const center=w2s(group.x,group.y);
      const radius=group.r*state.cam.s;
      ctx.save();
      ctx.globalAlpha=.14;
      ctx.fillStyle=group.color;
      ctx.shadowColor=group.color;
      ctx.shadowBlur=clamp(radius*.22,18,46);
      ctx.beginPath();
      ctx.arc(center.x,center.y,radius,0,Math.PI*2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.lineCap="round";
    for(const edge of state.vedges){
      const start=w2s(edge.a.x,edge.a.y);
      const end=w2s(edge.b.x,edge.b.y);
      const activation=metricUnit(edge.activation);
      const selected=state.selectedEdge===edge;
      const hovered=state.hoverEdge===edge;
      if(selected||hovered){
        ctx.strokeStyle=selected?"rgba(255,255,255,.52)":"rgba(255,255,255,.22)";
        ctx.lineWidth=edgeScreenWidth(edge,2.1);
        ctx.beginPath();
        ctx.moveTo(start.x,start.y);
        ctx.lineTo(end.x,end.y);
        ctx.stroke();
      }
      ctx.strokeStyle=`rgba(255,255,255,${.18+activation*.42})`;
      ctx.lineWidth=edgeScreenWidth(edge,selected ? .55 : (hovered ? .25 : 0));
      ctx.beginPath();
      ctx.moveTo(start.x,start.y);
      ctx.lineTo(end.x,end.y);
      ctx.stroke();
    }
    ctx.restore();

    for(const node of state.visible){
      const point=w2s(node.x,node.y);
      const selected=state.selectedNode===node;
      const hovered=state.hoverNode===node;
      const activation=metricUnit(node.activation);
      const emphasis=selected ? 1 : (hovered ? .55 : 0);
      const radius=node.r*state.cam.s*(1+emphasis*.05);
      const strokeWidth=clamp((nodeStrokeWidth(node)+emphasis)*state.cam.s,1.6,5.6);

      ctx.save();
      ctx.globalAlpha=.16+.18*activation+(selected ? .08 : 0);
      ctx.fillStyle=node.color;
      ctx.shadowColor=node.color;
      ctx.shadowBlur=(12+activation*18+emphasis*8)*state.cam.s;
      ctx.beginPath();
      ctx.arc(point.x,point.y,radius*.94,0,Math.PI*2);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(point.x,point.y,radius,0,Math.PI*2);
      ctx.fillStyle="rgba(3,6,10,.92)";
      ctx.fill();

      ctx.save();
      ctx.globalAlpha=.12+.10*activation;
      ctx.fillStyle=node.color;
      ctx.beginPath();
      ctx.arc(point.x,point.y,radius*.96,0,Math.PI*2);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(point.x,point.y,radius,0,Math.PI*2);
      ctx.strokeStyle=node.color;
      ctx.lineWidth=strokeWidth;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(point.x,point.y,radius*.34,0,Math.PI*2);
      ctx.fillStyle=node.color;
      ctx.fill();

      ctx.fillStyle="rgba(255,255,255,.94)";
      ctx.font=`500 ${clamp(11*state.cam.s+2,11,14)}px system-ui`;
      ctx.textAlign="center";
      ctx.fillText(node.name,point.x,point.y+radius+14);
    }

    if(!state.visible.length){
      ctx.fillStyle="#fff";
      ctx.font="650 18px system-ui";
      ctx.textAlign="center";
      ctx.fillText(state.focus.length?"This node has no direct children":"No root nodes found",state.w/2,state.h/2);
    }

    updateSelectionOrbit();
  }

  async function loadGraph(){
    state.loading=true;
    state.error=null;
    updateGraphControls();
    try{
      const response=await fetch(endpoints.graph,{cache:"no-store"});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const raw=await response.json();
      if(!raw||!Array.isArray(raw.nodes)||!Array.isArray(raw.connections))throw new Error("Invalid graph payload");
      parseGraph(raw);
      state.loading=false;
      recompute();
    }catch(error){
      console.error(error);
      state.loading=false;
      state.error=error instanceof TypeError?"Graph server unavailable":error.message;
      updateGraphControls();
      refreshPanels();
    }
  }

  async function copyGraph(method,url,done){
    if(state.copyBusy)return;
    state.copyBusy=true;
    updateGraphControls();
    toast(`${method} ${url}`);
    try{
      const response=await fetch(url,{method,cache:"no-store"});
      const text=await response.text();
      let payload=null;
      try{payload=text?JSON.parse(text):null}catch{}
      if(!response.ok||payload?.ok===false)throw new Error(payload?.error||text||`HTTP ${response.status}`);
      toast(done+(payload?.path?`: ${payload.path}`:""),true);
      if(url===endpoints.load)await loadGraph();
    }catch(error){
      console.error(error);
      toast(transport(error),false);
    }finally{
      state.copyBusy=false;
      updateGraphControls();
    }
  }

  function bindEvents(){
    state.canvas.addEventListener("pointerdown",event=>{
      if(event.button!==0)return;
      event.preventDefault();
      const point=graphPoint(event);
      const node=pickNode(point.x,point.y);
      const edge=node?null:pickEdge(point.x,point.y);
      const group=node||edge?null:pickGroup(point.x,point.y);
      const target=node||edge||group||null;
      const targetType=node?"node":edge?"edge":group?"group":"background";
      state.pointer={down:true,drag:false,x:point.x,y:point.y,startX:point.x,startY:point.y,id:event.pointerId,mode:node?"node":group?"group":"camera",node,edge,group,target,targetType};
      try{state.canvas.setPointerCapture(event.pointerId)}catch{}
      graphCursor();
    });

    state.canvas.addEventListener("pointermove",event=>{
      const point=graphPoint(event);
      if(state.pointer.down){
        const dxScreen=point.x-state.pointer.x;
        const dyScreen=point.y-state.pointer.y;
        const dxWorld=dxScreen/Math.max(state.cam.s,.001);
        const dyWorld=dyScreen/Math.max(state.cam.s,.001);
        if(!state.pointer.drag&&Math.hypot(point.x-state.pointer.startX,point.y-state.pointer.startY)>DRAG_THRESHOLD_PX)state.pointer.drag=true;
        if(state.pointer.drag){
          if(state.pointer.node){
            state.pointer.node.x+=dxWorld;
            state.pointer.node.y+=dyWorld;
            state.pointer.node.vx=0;
            state.pointer.node.vy=0;
          }else if(state.pointer.group){
            state.pointer.group.x+=dxWorld;
            state.pointer.group.y+=dyWorld;
            for(const node of state.pointer.group.members){
              node.x+=dxWorld;
              node.y+=dyWorld;
              node.vx=0;
              node.vy=0;
            }
            refreshGroupGeometry();
          }else{
            state.cam.x-=dxWorld;
            state.cam.y-=dyWorld;
          }
          state.hoverNode=null;
          state.hoverEdge=null;
          state.hoverGroup=null;
        }
      }else{
        graphHoverAt(point.x,point.y);
      }
      state.pointer.x=point.x;
      state.pointer.y=point.y;
      graphCursor();
    });

    state.canvas.addEventListener("pointerup",event=>{
      const point=graphPoint(event);
      const wasDrag=state.pointer.drag;
      const {targetType,target}=state.pointer;
      state.pointer.down=false;
      state.pointer.drag=false;
      try{if(state.pointer.id!==null&&state.pointer.id!==undefined)state.canvas.releasePointerCapture(state.pointer.id)}catch{}
      state.pointer.id=null;
      if(!wasDrag)handlePointerClick(targetType,target);
      graphHoverAt(point.x,point.y);
    });

    state.canvas.addEventListener("pointercancel",()=>{
      state.pointer={down:false,drag:false,x:0,y:0,startX:0,startY:0,id:null,mode:"camera",node:null,edge:null,group:null,target:null,targetType:"background"};
      state.hoverNode=null;
      state.hoverEdge=null;
      state.hoverGroup=null;
      graphCursor();
    });

    state.canvas.addEventListener("pointerleave",()=>{
      if(state.pointer.down)return;
      state.hoverNode=null;
      state.hoverEdge=null;
      state.hoverGroup=null;
      graphCursor();
    });

    state.canvas.addEventListener("wheel",event=>{
      event.preventDefault();
      state.cam.x+=event.deltaX/state.cam.s;
      state.cam.y+=event.deltaY/state.cam.s;
    },{passive:false});

    $("refresh-graph").onclick=loadGraph;
    $("save-graph-copy").onclick=async()=>{if(await confirmAction("Save graph copy?","This will overwrite the saved graph copy on disk. Continue only if this is intentional.","Save copy"))copyGraph("POST",endpoints.export,"Graph copy saved")};
    $("load-graph-copy").onclick=async()=>{if(await confirmAction("Load saved graph copy?","This will replace the current in-memory graph with the saved copy. Unsaved current state may be lost.","Load copy"))copyGraph("GET",endpoints.load,"Graph copy loaded")};
    $("explode-toggle").onclick=()=>{state.explode=!state.explode;recompute()};
  }

  function loop(now){
    const dt=clamp((now-state.last)/16.6667,.5,1.8);
    state.last=now;
    step(dt);
    renderGraph();
    requestAnimationFrame(loop);
  }

  bindEvents();
  updateGraphControls();
  refreshPanels();
  requestAnimationFrame(loop);

  return{
    loadGraph,
    renderGraph,
    setActive(active){
      state.active=Boolean(active);
      updateSelectionOrbit();
    },
    onEscape(){
      if(!state.active)return false;
      return false;
    }
  };
}
