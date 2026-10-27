// エンジン単体テスト: CPUだけで対局を回し、異常終了や全滅ドローがないか確かめる
const {loadEngine}=require('../server/engine-loader');
const E=loadEngine();
const RULES={pawn:true,final:true,pass:true,promo:true,throne:true,ai:'normal'};
let draws=0,turns=0;const G=+process.env.GAMES||60;
for(let g=0;g<G;g++){
  E.newGame(null,{...RULES,ai:['easy','normal','hard'][g%3]});
  const S=E.state();S.players[0].cpu=true;
  let n=0;while(!S.over&&n++<80)E.step(null);
  if(!S.over)throw new Error('対局が終わらない');
  if(!E.alive().length)draws++;turns+=S.turn;
}
console.log(`${G}局 OK / 全滅ドロー ${draws} / 平均 ${(turns/G).toFixed(1)}手`);
