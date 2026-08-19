import * as m from '../prompts/vohuPrompts.js';
const stub={knowledge:{},posts:[],competitors:[],insight:'x',answers:{},constraints:[],
 pageContent:'x',userNote:'',mission:'m',content:'x',today:'t',card:{},prediction:'p',
 userAnswer:'y',userReason:null,edits:[],hypothesisHistory:[],operationalLevelAtRun:'x',
 competitorMap:null,contentAnalysis:null,hasMetrics:false,market:null,userSaid:[]};
let ok=0,bad=[];
for(const [k,v] of Object.entries(m)) if(typeof v==='function'&&k.endsWith('_PROMPT')){
  try{ const s=v(stub); if(typeof s!=='string'||!s.length) throw new Error('خروجی خالی'); ok++; }
  catch(e){ bad.push(`${k}: ${e.message}`); } }
console.log(`سازنده‌های پرامپت سالم: ${ok}`);
if(bad.length){ console.log('خراب:'); bad.forEach(b=>console.log('  ✗ '+b)); process.exit(1); }
const schemas=Object.keys(m).filter(k=>k.endsWith('_SCHEMA'));
console.log(`اسکیماها: ${schemas.length} · ${schemas.map(s=>s.replace('_SCHEMA','')).join(', ')}`);
