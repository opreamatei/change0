export const $=id=>document.getElementById(id);
export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const num=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
export const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);

const DEFAULT_ENDPOINT_BASE="http://127.0.0.1:8085";
const ENDPOINT_STORAGE_KEY="graph-viewer.endpoint-base.v1";
const LOCAL_HTTP_HOSTS=new Set(["127.0.0.1","localhost","[::1]","::1"]);

export function buildEndpoints(base){
  return{
    graph:`${base}/graph`,
    export:`${base}/graph/export`,
    load:`${base}/graph/load`,
    msg:`${base}/message`,
    rsStart:`${base}/research/start`,
    rsEvents:`${base}/research/events`,
    goalCreate:`${base}/goal/create`,
    goalEvents:`${base}/goal/events`,
    goalList:`${base}/goal/list`,
    goalExport:`${base}/goal/export`,
    goalLoad:`${base}/goal/load`,
    goalDecompose:`${base}/goal/decompose`
  };
}

export function defaultEndpointBase(){
  return DEFAULT_ENDPOINT_BASE;
}

export function normalizeEndpointBase(value){
  const raw=String(value||"").trim();
  if(!raw)return DEFAULT_ENDPOINT_BASE;
  const candidate=/^https?:\/\//i.test(raw)?raw:`https://${raw}`;
  let url;
  try{
    url=new URL(candidate);
  }catch{
    throw new Error("Endpoint invalid. Use a full HTTPS URL, for example https://server.example.com.");
  }
  const isLocalHttp=url.protocol==="http:"&&LOCAL_HTTP_HOSTS.has(url.hostname);
  if(url.protocol!=="https:"&&!isLocalHttp){
    throw new Error("Endpoint must use HTTPS. Only local development may use http://127.0.0.1:8085 or http://localhost.");
  }
  url.username="";
  url.password="";
  url.search="";
  url.hash="";
  url.pathname=url.pathname.replace(/\/+$/,"");
  return url.toString().replace(/\/$/,"");
}

export function loadEndpointBase(){
  try{
    return normalizeEndpointBase(localStorage.getItem(ENDPOINT_STORAGE_KEY)||DEFAULT_ENDPOINT_BASE);
  }catch{
    return DEFAULT_ENDPOINT_BASE;
  }
}

export const EP=buildEndpoints(loadEndpointBase());

export function setEndpointBase(value){
  const base=normalizeEndpointBase(value);
  Object.assign(EP,buildEndpoints(base));
  try{localStorage.setItem(ENDPOINT_STORAGE_KEY,base)}catch{}
  return base;
}

const OFFLINE="Open CHANGE terminal client and select Start Server (run ./build.sh)";

export const warn=`<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86l-7.5 13A1 1 0 0 0 3.71 18h16.58a1 1 0 0 0 .92-1.5l-7.5-13a1 1 0 0 0-1.84 0z"></path>`;
export const ok=`<path d="M20 6L9 17l-5-5"></path>`;

export const meta={
  sse_connected:["SSE Connected","#34d399"],
  research_started:["Research Started","#38bdf8"],
  "ds-start":["Deep Search Start","#60a5fa"],
  "round-start":["Round Start","#f59e0b"],
  "ds-model-response":["Model Response","#22d3ee"],
  "judge-pass":["Judge Pass","#34d399"],
  "judge-fail":["Judge Fail","#f87171"],
  "ds-end":["Deep Search End","#38bdf8"],
  goal_create_started:["Goal Create Started","#38bdf8"],
  goal_created:["Goal Created","#34d399"],
  goal_create_failed:["Goal Create Failed","#fb7185"]
};

export function transport(error){
  const message=error instanceof Error?error.message:String(error);
  return error instanceof TypeError||/Failed to fetch|timed out|Could not connect/i.test(message)?`Transport unavailable. ${OFFLINE}`:message;
}

export function grid(ctx,w,h,ox=0,oy=0,op=.07,sp=48){
  const opacity=Math.min(op,.10);
  const offsetX=((ox%sp)+sp)%sp;
  const offsetY=((oy%sp)+sp)%sp;
  ctx.save();
  ctx.strokeStyle=`rgba(255,255,255,${opacity})`;
  ctx.lineWidth=1;
  ctx.beginPath();
  for(let x=-offsetX;x<=w+sp;x+=sp){
    ctx.moveTo(Math.round(x)+.5,0);
    ctx.lineTo(Math.round(x)+.5,h);
  }
  for(let y=-offsetY;y<=h+sp;y+=sp){
    ctx.moveTo(0,Math.round(y)+.5);
    ctx.lineTo(w,Math.round(y)+.5);
  }
  ctx.stroke();
  ctx.restore();
}

export function base(ctx,w,h,ox=0,oy=0){
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle="rgba(0,0,0,.82)";
  ctx.fillRect(0,0,w,h);
  grid(ctx,w,h,ox,oy);
}

export function resize(canvas){
  const rect=canvas.getBoundingClientRect();
  const d=Math.max(1,Math.min(devicePixelRatio||1,2));
  const w=Math.max(1,Math.round(rect.width));
  const h=Math.max(1,Math.round(rect.height));
  const bw=Math.round(w*d);
  const bh=Math.round(h*d);
  if(canvas.width!==bw)canvas.width=bw;
  if(canvas.height!==bh)canvas.height=bh;
  const c=canvas.getContext("2d");
  c.setTransform(d,0,0,d,0,0);
  return {w,h,d,c};
}

export function status(root,icon,text,state){
  root.className=`status-chip is-${state}`;
  text.textContent=state==="connected"?"Connected":state==="connecting"?"Connecting":state==="reconnecting"?"Reconnecting":"Disconnected";
  icon.innerHTML=state==="connected"?ok:warn;
}

export function rand32(){
  const bytes=new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");
}

export function id(prefix){
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,63);
}

export function local(key,def){
  try{return JSON.parse(localStorage.getItem(key))??def}catch{return def}
}

export function save(key,val){
  try{localStorage.setItem(key,JSON.stringify(val))}catch(error){console.warn(error)}
}

export function color(idValue){
  return `hsl(${((idValue*137.508)%360+360)%360} 68% 58%)`;
}
