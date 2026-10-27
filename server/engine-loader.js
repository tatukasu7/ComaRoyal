// public/engine.js をNodeの隔離コンテキストに読み込む。
// エンジンはグローバル S を使うので、部屋ごとに S を差し替えてから関数を呼ぶ(Nodeは単一スレッドなので安全)。
const fs=require('fs'),path=require('path'),vm=require('vm');
function loadEngine(){
  const ctx=vm.createContext({console,Math,Date,JSON,Map,Set,Array,Object,Number,String,Error});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','engine.js'),'utf8'),ctx,{filename:'engine.js'});
  const A=ctx.ENGINE_API;
  return {
    ctx,A,
    state:()=>ctx.S,
    use:s=>{ctx.S=s;},
    newGame:(humans,rules)=>{A.engineNewGame(humans,rules);return ctx.S;},
    step:(acts)=>A.step(acts,true),
    alive:()=>A.alive(),
    snap:()=>A.snap(),
    promote:p=>A.promote(p),
    unpackAct:a=>A.unpackAct(a),
    rankOf:p=>A.rankOf(p),
    AI_LEVELS:A.AI_LEVELS,
  };
}
module.exports={loadEngine};
