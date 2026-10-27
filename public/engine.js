// 駒ロワ ゲームエンジン — ブラウザ(<script>)とNode(vm)の両方で読み込む。
// 状態はグローバル変数 S に置く。サーバーは部屋ごとに S を差し替えてから step() を呼ぶ。

const N=11;
const SHRINK_AT=[6,10,14,18,22];
const GOLD=[[0,-1],[-1,-1],[1,-1],[-1,0],[1,0],[0,1]];
const PROMO={fu:'to',kyo:'nkyo',kei:'nkei',gin:'ngin',kaku:'uma',hi:'ryu'};
const D8=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
const K={
  fu:{k:'歩',v:1,d:'前へ1',steps:[[0,-1]]},
  kyo:{k:'香',v:2,d:'前へ直進',slides:[[0,-1]]},
  kei:{k:'桂',v:2,d:'前方へ跳ぶ',jumps:[[-1,-2],[1,-2]]},
  gin:{k:'銀',v:3,d:'前と斜め',steps:[[0,-1],[-1,-1],[1,-1],[-1,1],[1,1]]},
  kin:{k:'金',v:3,d:'斜め後ろ以外',steps:[[0,-1],[-1,-1],[1,-1],[-1,0],[1,0],[0,1]]},
  kaku:{k:'角',v:5,d:'斜めに直進',slides:[[1,1],[1,-1],[-1,1],[-1,-1]]},
  hi:{k:'飛',v:5,d:'縦横に直進',slides:[[0,1],[0,-1],[1,0],[-1,0]]},
  ou:{k:'王',v:4,d:'全方向1',steps:D8},
  to:{k:'と',v:3,d:'金と同じ',steps:GOLD,pr:1},
  nkyo:{k:'杏',v:3,d:'金と同じ',steps:GOLD,pr:1},
  nkei:{k:'圭',v:3,d:'金と同じ',steps:GOLD,pr:1},
  ngin:{k:'全',v:3,d:'金と同じ',steps:GOLD,pr:1},
  uma:{k:'馬',v:7,d:'斜め直進＋縦横1',slides:[[1,1],[1,-1],[-1,1],[-1,-1]],steps:[[0,1],[0,-1],[1,0],[-1,0]],pr:1},
  ryu:{k:'龍',v:7,d:'縦横直進＋斜め1',slides:[[0,1],[0,-1],[1,0],[-1,0]],steps:[[1,1],[1,-1],[-1,1],[-1,-1]],pr:1},
};
const LOOT_W=[['kyo',4],['kei',4],['gin',3],['kin',3],['kaku',1],['hi',1]];
const DIRNAME=['上','右','下','左'];
const NAMES=[['あなた','#6fa3e0'],['鷹','#d0674f'],['霞','#9b80cf'],['狐','#d79a3c'],['蛇','#5aa877'],['鴉','#c45c8f'],['雷','#c9b24a'],['霧','#7fa3b3']];


var S=null;

const rnd=n=>Math.floor(Math.random()*n);
const key=(x,y)=>x+','+y;
const ring=(x,y)=>Math.min(x,y,N-1-x,N-1-y);
const inB=(x,y)=>x>=0&&y>=0&&x<N&&y<N;
const safeAt=(x,y)=>inB(x,y)&&ring(x,y)>=S.lvl&&!S.holes.includes(key(x,y));
const HOLE_FROM=24;
const shrinkList=()=>S.rules.final?[6,10,14,18]:SHRINK_AT;
const isBare=p=>S.rules.pawn&&!p.promoted&&p.learned.length===0;
// 同時進入の勝敗: 1=aの勝ち 0=互角(弾かれる) -1=aの負け
function cmp(a,b){
  if(S.rules.pawn){const ab=isBare(a),bb=isBare(b);if(ab&&bb)return 0;if(ab)return 1;if(bb)return -1;}
  const d=strength(a)-strength(b);if(d)return Math.sign(d);
  if(S.rules.final&&a.kills!==b.kills)return Math.sign(a.kills-b.kills);
  return 0;
}
function whyCmp(a,b){
  if(S.rules.pawn){const ab=isBare(a),bb=isBare(b);if(ab&&bb)return '両方とも素の歩';if(ab||bb)return '素の歩は轢けない';}
  const ma=movesOf(a).length,mb=movesOf(b).length;if(ma!==mb)return `動きの数 ${ma} 対 ${mb}`;
  const va=movesOf(a).reduce((s,k)=>s+K[k].v,0),vb=movesOf(b).reduce((s,k)=>s+K[k].v,0);if(va!==vb)return `動きの価値 ${va} 対 ${vb}`;
  if(S.rules.final&&a.kills!==b.kills)return `撃破数 ${a.kills} 対 ${b.kills}`;
  return '数・価値'+(S.rules.final?'・撃破数':'')+'がすべて同じ';
}
function fallInfo(){
  const sa=shrinkList(),t=sa.find(t=>t>=S.turn);
  if(t!=null){const prev=sa[sa.indexOf(t)-1]||0;return {at:t,total:t-prev,kind:'ring'};}
  if(S.rules.final&&S.nextHole){const at=Math.max(S.turn,HOLE_FROM);return {at,total:at===HOLE_FROM?HOLE_FROM-sa[sa.length-1]:1,kind:'cell'};}
  return null;
}
function pickHole(){const c=[];for(let y=0;y<N;y++)for(let x=0;x<N;x++){if(ring(x,y)===S.lvl&&ring(x,y)<5&&!S.holes.includes(key(x,y)))c.push(key(x,y));}S.nextHole=c.length?c[rnd(c.length)]:null;}
function cpuWantPick(p,k){if(!wouldLearn(p,k))return false;if(!isBare(p))return true;return K[k].v>=3||(K[k].v===2&&Math.random()<.35);}
const rot=([dx,dy],f)=>f===0?[dx,dy]:f===1?[-dy,dx]:f===2?[-dx,-dy]:[dy,-dx];
const movesOf=p=>[S.rules.promo?(p.base||'fu'):(p.promoted?'ou':'fu'),...p.learned];
const throneOn=()=>S.rules.throne&&S.rules.final&&S.lvl>=4;
const inZone=p=>throneOn()?ring(p.x,p.y)===5:ring(p.x,p.y)===S.lvl;
const promoPreview=p=>[p.base||'fu',...p.learned].map(k=>PROMO[k]?`${K[k].k}→${K[PROMO[k]].k}`:null).filter(Boolean).join('、');
function promote(p){
  if(S.rules.promo){p.base=PROMO[p.base||'fu']||p.base;p.learned=p.learned.map(k=>PROMO[k]||k);}
  else p.learned=p.learned.filter(k=>k!=='ou');
  p.promoted=true;p.canPromo=false;
  log(`${p.name}が成った`+(S.rules.promo?`(${movesOf(p).map(k=>K[k].k).join('・')})`:''));
}
function cpuWantPromo(p){if(p.learned.some(k=>k==='kaku'||k==='hi'))return true;if(p.learned.length<=1)return true;return Math.random()<.6;}
const strength=p=>{const m=movesOf(p);return m.length*100+m.reduce((a,k)=>a+K[k].v,0);};
const alive=()=>S.players.filter(p=>p.alive);
const topKind=p=>{const m=movesOf(p);return m.slice(1).concat(m[0]).sort((a,b)=>K[b].v-K[a].v)[0];};
const nextShrink=()=>{const f=fallInfo();return f?f.at:null;};

const log=m=>S.log.push({t:S.turn,m});

function occMap(){const m=new Map();for(const p of alive())m.set(key(p.x,p.y),p);return m;}
function reachFrom(x,y,f,moves,occ){
  const out=new Map();
  const add=(nx,ny,kind,path=[],through=false)=>{const k=key(nx,ny),e=out.get(k);if(!e||(e.through&&!through))out.set(k,{x:nx,y:ny,kind,path,through});};
  for(const kind of moves){const d=K[kind];
    for(const v of (d.steps||[]).concat(d.jumps||[])){const [dx,dy]=rot(v,f);if(safeAt(x+dx,y+dy))add(x+dx,y+dy,kind);}
    for(const v of d.slides||[]){const [dx,dy]=rot(v,f);let nx=x+dx,ny=y+dy;const path=[];let passed=false;
      while(safeAt(nx,ny)){add(nx,ny,kind,path.slice(),passed);
        if(occ.has(key(nx,ny))){if(!S.rules.pass)break;passed=true;}
        path.push(key(nx,ny));nx+=dx;ny+=dy;}}
  }
  return [...out.values()];
}
const reach=(p,occ)=>reachFrom(p.x,p.y,p.f,movesOf(p),occ);
function wouldLearn(p,k){if(movesOf(p).includes(k))return false;if(p.learned.length<2)return true;return K[k].v>Math.min(...p.learned.map(x=>K[x].v));}
function learn(p,k){
  if(!wouldLearn(p,k))return false;
  if(p.learned.length<2)p.learned.push(k);
  else{let i=0;p.learned.forEach((x,j)=>{if(K[x].v<K[p.learned[i]].v)i=j;});p.learned[i]=k;}
  return true;
}
function pickKind(){const tot=LOOT_W.reduce((a,w)=>a+w[1],0);let r=Math.random()*tot;for(const [k,w] of LOOT_W){if((r-=w)<0)return k;}return 'kyo';}
function spawnLoot(n){
  const occ=occMap();
  for(let i=0;i<n;i++){for(let t=0;t<60;t++){const x=rnd(N),y=rnd(N);
    if(!safeAt(x,y)||occ.has(key(x,y))||S.loot.some(l=>l.x===x&&l.y===y))continue;
    S.loot.push({x,y,kind:pickKind()});break;}}
}
function faceCenter(x,y){const dx=5-x,dy=5-y;if(!dx&&!dy)return 0;return Math.abs(dx)>Math.abs(dy)?(dx>0?1:3):(dy>0?2:0);}

function engineNewGame(humans,rules){
  const players=[],taken=[];
  for(let i=0;i<8;i++){
    let pos,tries=0;
    do{pos=[1+rnd(N-2),1+rnd(N-2)];tries++;}
    while(taken.some(t=>Math.max(Math.abs(t[0]-pos[0]),Math.abs(t[1]-pos[1]))<(tries<800?3:2))&&tries<4000);
    taken.push(pos);
    const [x,y]=pos,f=faceCenter(x,y);
    players.push({id:i,name:humans?(humans[i]?humans[i].name:NAMES[i][0]):NAMES[i][0],color:NAMES[i][1],cpu:humans?!humans[i]:i>0,x,y,f,deg:f*90,learned:[],promoted:false,edge:0,alive:true,kills:0,diedTurn:null,killer:null,aggr:.6+Math.random()*.8});
  }
  S={turn:1,lvl:0,players,loot:[],log:[],over:false,sel:null,spectate:false,inspect:0,showDanger:true,tutorial:false,flash:null,rules:{...rules},holes:[],nextHole:null};
  spawnLoot(12);
  const rl=[S.rules.pawn&&'歩は轢けない',S.rules.pass&&'読みで突破',S.rules.final&&'決戦場',S.rules.promo&&'将棋の成り',S.rules.final&&S.rules.throne&&'玉座'].filter(Boolean);
  rl.push(`CPU: ${AI_LEVELS[S.rules.ai]||'ふつう'}`);
  S.log.push({t:0,m:'開局。全員が歩から始まる。'+(rl.length?`追加ルール: ${rl.join('・')}`:'基本ルール')});
  S.rec={frames:[snap()],id:Date.now()};S.saved=false;S.g=S.rec.id;S.meIdx=0;
}

// CPUの候補手と評価(ノイズなし)

function cpuOptions(p,occ,th,smart){
  const opts=[];
  for(const r of reach(p,occ)){const l=S.loot.find(l=>l.x===r.x&&l.y===r.y);
    opts.push({a:{type:'move',x:r.x,y:r.y,kind:r.kind,pick:l?(S.rules.pawn?cpuWantPick(p,l.kind):true):false},x:r.x,y:r.y,f:p.f,mv:true,risky:r.through});}
  for(const d of [1,3,2])opts.push({a:{type:'rot',f:(p.f+d)%4},x:p.x,y:p.y,f:(p.f+d)%4,mv:false});
  opts.push({a:{type:'wait'},x:p.x,y:p.y,f:p.f,mv:false});
  const ns=nextShrink(),tu=ns==null?99:ns-S.turn,fi=fallInfo();
  for(const o of opts){
    const r=ring(o.x,o.y);let s=r*.5;
    if(o.risky)s-=1.2;
    if(fi&&fi.kind==='ring'&&r<S.lvl+1)s-=30/(tu+1);
    if(fi&&fi.kind==='cell'&&key(o.x,o.y)===S.nextHole)s-=30/(tu+1);
    const l=S.loot.find(l=>l.x===o.x&&l.y===o.y);if(l&&o.a.pick&&wouldLearn(p,l.kind))s+=K[l.kind].v*3;
    const q=occ.get(key(o.x,o.y));if(q&&q!==p)s+=(2+K[topKind(q)].v)*p.aggr;
    for(const t of th.get(key(o.x,o.y))||[]){if(t===p)continue;const c=cmp(p,t);s-=!o.mv?4.5:c<0?3.5:c===0?1.2:.3;}
    const fut=reachFrom(o.x,o.y,o.f,movesOf(p),occ);
    const inward=fut.length?Math.max(...fut.map(z=>ring(z.x,z.y)))-r:-2;
    s+=inward*(.6+3/(tu+1))+fut.length*.08;
    if(smart&&throneOn()&&r===5&&!p.promoted)s+=3;
    o.s=s;
  }
  return opts;
}
const AI_LEVELS={easy:'やさしい',normal:'ふつう',hard:'つよい'};
const aiLevel=()=>AI_LEVELS[S.rules.ai]?S.rules.ai:'normal';
function cpuAction(p,occ,th){
  const lv=aiLevel();
  if(lv==='hard')return cpuHard(p,occ,th);
  const opts=cpuOptions(p,occ,th,false);
  if(lv==='easy'){
    // 弱め: 大きなノイズ。危険を読み違えることもある
    if(Math.random()<.3){const safe=opts.filter(o=>o.s>-8);const pool=safe.length?safe:opts;return pool[rnd(pool.length)].a;}
    for(const o of opts)o.s+=(Math.random()-.5)*7;
  }else for(const o of opts)o.s+=(Math.random()-.5)*2;
  return opts.reduce((a,b)=>b.s>a.s?b:a).a;
}
// つよい: 相手の手を確率で予想し、候補手ごとに同時解決を何通りもシミュレートして選ぶ
function cloneState(){
  return {...S,players:S.players.map(p=>({...p,learned:p.learned.slice()})),loot:S.loot.map(l=>({...l})),holes:S.holes.slice(),log:[],rec:null,sel:null,flash:null,saved:true};
}
function sampleFrom(dist){let r=Math.random();for(const d of dist){if((r-=d.p)<0)return d.a;}return dist[dist.length-1].a;}
function cpuHard(p,occ,th){
  const mine=cpuOptions(p,occ,th,true).sort((a,b)=>b.s-a.s).slice(0,12);
  const others=alive().filter(q=>q!==p);
  const dists=others.map(q=>{
    const os=cpuOptions(q,occ,th,true).sort((a,b)=>b.s-a.s).slice(0,6);
    const mx=os[0].s,ws=os.map(o=>Math.exp((o.s-mx)/1.6)),sum=ws.reduce((a,b)=>a+b,0);
    return {q,dist:os.map((o,i)=>({a:o.a,p:ws[i]/sum}))};
  });
  const K0=p.kills,S0=strength(p),N_S=14;
  const samples=Array.from({length:N_S},()=>{const m={};for(const d of dists)m[d.q.id]=sampleFrom(d.dist);return m;});
  const base=cloneState(),saved=S;
  let best=mine[0],bs=-1e9;
  try{
    for(const o of mine){
      let tot=0;
      for(const smp of samples){
        S={...base,players:base.players.map(x=>({...x,learned:x.learned.slice(),cpu:false})),loot:base.loot.map(l=>({...l})),holes:base.holes.slice(),log:[]};
        step({...smp,[p.id]:o.a},true);
        const me=S.players[p.id];
        if(!me.alive){tot-=60;continue;}
        let v=(me.kills-K0)*14+(strength(me)-S0)/12;
        const oc=occMap();let threats=0;
        for(const q of alive())if(q!==me&&reach(q,oc).some(r=>r.x===me.x&&r.y===me.y))threats++;
        v-=threats*1.6;
        const f2=fallInfo();
        if(f2&&(f2.kind==='ring'?ring(me.x,me.y)===S.lvl:key(me.x,me.y)===S.nextHole))v-=6/(Math.max(0,f2.at-S.turn)+1);
        if(inZone(me)&&!me.promoted)v+=me.edge*.9;
        v+=reach(me,oc).length*.06+ring(me.x,me.y)*.3;
        if(alive().length===1)v+=40;
        tot+=v;
      }
      const sc=tot/samples.length+o.s*.15;
      if(sc>bs){bs=sc;best=o;}
    }
  }finally{S=saved;}
  return best.a;
}


function snap(){return {t:S.turn,lvl:S.lvl,holes:S.holes.slice(),nh:S.nextHole,le:S.log.length,
  p:S.players.map(p=>[p.x,p.y,p.f,p.learned.slice(),p.promoted?1:0,p.alive?1:0,p.kills,p.edge,p.diedTurn,p.killer,p.base||'fu',p.canPromo?1:0]),
  l:S.loot.map(l=>[l.x,l.y,l.kind])};}
const packAct=a=>a.type==='move'?['m',a.x,a.y,a.kind,a.pick?1:0]:a.type==='rot'?['r',a.f]:['w'];

function step(actMap,quiet){
  const occ=occMap(),th=new Map();
  for(const q of alive())for(const r of reach(q,occ)){const k=key(r.x,r.y);(th.get(k)||th.set(k,[]).get(k)).push(q);}
  const acts={},ps=alive();
  for(const p of ps)acts[p.id]=p.cpu?cpuAction(p,occ,th):legalAct(p,actMap&&actMap[p.id],occ);
  if(S.rec){const fr=S.rec.frames[S.rec.frames.length-1];fr.a={};for(const p of ps)fr.a[p.id]=packAct(acts[p.id]);}
  for(const p of ps){const a=acts[p.id];p._o=[p.x,p.y];p._m=a.type==='move';p._d=p._m?[a.x,a.y]:[p.x,p.y];p._dead=false;p._blk=null;
    const e=p._m?reach(p,occ).find(r=>r.x===a.x&&r.y===a.y):null;p._path=e&&e.through?e.path:[];}
  // 読みで突破: 通り道の駒がその場に残っていたら、その手前で止まる
  const applyBlocks=()=>{let changed=false;
    for(const p of ps){if(p._dead||!p._path.length||!p._m)continue;
      const stay=new Map();for(const q of ps)if(q!==p&&!q._dead&&!q._m)stay.set(key(...q._d),q);
      const i=p._path.findIndex(k=>stay.has(k));if(i<0)continue;
      const d=i===0?p._o:p._path[i-1].split(',').map(Number);
      p._blk=stay.get(p._path[i]);p._path=[];p._d=d;
      if(d[0]===p._o[0]&&d[1]===p._o[1])p._m=false;
      changed=true;}
    return changed;};
  const caps=[],bounces=[];
  const cap=(v,k)=>{if(v._dead)return;v._dead=true;caps.push([v,k,isBare(k)&&v._m&&!isBare(v)]);};
  for(let it=0,ch=true;ch&&it<30;it++){ch=applyBlocks();
    const g=new Map();
    for(const p of ps){if(p._dead)continue;const k=key(...p._d);(g.get(k)||g.set(k,[]).get(k)).push(p);}
    for(const grp of g.values()){if(grp.length<2)continue;
      const st=grp.find(p=>!p._m),mv=grp.filter(p=>p._m).sort((a,b)=>cmp(b,a));
      if(!mv.length)continue;
      if(mv.length>1&&cmp(mv[0],mv[1])===0){for(const m of mv){m._m=false;m._d=m._o;}bounces.push(mv.map(m=>m.name).join('と'));}
      else{for(const m of mv.slice(1))cap(m,mv[0]);if(st)cap(st,mv[0]);}
      ch=true;
    }
  }
  for(const p of ps){if(p._dead)continue;[p.x,p.y]=p._d;const a=acts[p.id];
    if(a.type==='rot'){const d=(a.f-p.f+4)%4;p.deg+=d===3?-90:d*90;p.f=a.f;}}
  for(const b of bounces)log(`${b}が衝突して弾かれた`);
  for(const p of ps)if(p._blk&&!p._dead)log(`${p.name}の${K[acts[p.id].kind].k}は${p._blk.name}に阻まれて手前で止まった`);
  for(const [v,k,gk] of caps){
    if(gk)log(`素の歩の${k.name}が${v.name}との正面衝突を制した`);
    v.alive=false;v.diedTurn=S.turn;v.killer=k.id;k.kills++;
    const cand=movesOf(v).filter(m=>m!=='fu'&&!movesOf(k).includes(m)).sort((a,b)=>K[b].v-K[a].v);
    let got=null;for(const c of cand){if(learn(k,c)){got=c;break;}}
    log(`${k.name}が${v.name}を取った`+(got?`。「${K[got].k}」を奪う`:''));
  }
  for(const p of alive()){const i=S.loot.findIndex(l=>l.x===p.x&&l.y===p.y);
    const a=acts[p.id]||{},want=!S.rules.pawn||(a.type==='move'&&a.pick);
    if(i>=0&&want&&learn(p,S.loot[i].kind)){log(`${p.name}が「${K[S.loot[i].kind].k}」を拾った`);S.loot.splice(i,1);}}
  for(const p of alive()){
    if(p.cpu&&p.canPromo&&!p.promoted&&Math.random()<.25)promote(p);
    if(inZone(p)){p.edge++;
      if(!p.promoted&&!p.canPromo&&p.edge>=3){
        if(!S.rules.promo)promote(p);
        else if(p.cpu){if(cpuWantPromo(p))promote(p);else{p.canPromo=true;log(`${p.name}は成らずを選んだ`);}}
        else{p.canPromo=true;log(`${p.name}は成れるようになった`);}
      }}
    else p.edge=0;
  }
  const sl=shrinkList();
  if(sl.includes(S.turn)){
    S.lvl++;log('外周が盤外になった');S.flash='盤が縮んだ';
    for(const p of alive())if(ring(p.x,p.y)<S.lvl){p.alive=false;p.diedTurn=S.turn;p.killer=null;log(`${p.name}が盤外に落ちた`);}
    S.loot=S.loot.filter(l=>ring(l.x,l.y)>=S.lvl);
    if(S.rules.final&&S.turn===sl[sl.length-1]){log(`決戦場。${HOLE_FROM}手目から1マスずつ落ちる`);pickHole();}
  }
  else if(S.rules.final&&S.turn>=HOLE_FROM&&S.nextHole){
    const h=S.nextHole;S.holes.push(h);S.flash='マスが落ちた';
    for(const p of alive())if(key(p.x,p.y)===h){p.alive=false;p.diedTurn=S.turn;p.killer=null;log(`${p.name}が落ちたマスごと盤外へ`);}
    S.loot=S.loot.filter(l=>key(l.x,l.y)!==h);
    pickHole();
  }
  if(S.turn%3===0&&S.turn<sl[sl.length-1])spawnLoot(2);
  S.turn++;S.sel=null;
  if(alive().length<=1||S.turn>60)S.over=true;
  if(S.rec)S.rec.frames.push(snap());
  if(S.over&&typeof onGameOver==='function')onGameOver();
  if(!quiet&&typeof onAfterStep==='function')onAfterStep();
}


function legalAct(p,a,occ){
  if(!a)return {type:'wait'};
  if(a.type==='rot'&&[0,1,2,3].includes(a.f))return {type:'rot',f:a.f};
  if(a.type==='move'){const r=reach(p,occ).find(r=>r.x===a.x&&r.y===a.y);if(r)return {type:'move',x:r.x,y:r.y,kind:r.kind,pick:!!a.pick};}
  return {type:'wait'};
}
const unpackAct=a=>!Array.isArray(a)?null:a[0]==='m'?{type:'move',x:+a[1],y:+a[2],kind:a[3],pick:!!a[4]}:a[0]==='r'?{type:'rot',f:+a[1]}:{type:'wait'};

function rankOf(p){if(p.alive)return 1;return 1+S.players.filter(q=>q.alive||(q.diedTurn>p.diedTurn)).length;}

// Nodeから参照するための窓口(const宣言はvmの外から見えないため)
var ENGINE_API={engineNewGame,step,alive,snap,packAct,unpackAct,legalAct,promote,rankOf,movesOf,strength,AI_LEVELS,NAMES,K};
