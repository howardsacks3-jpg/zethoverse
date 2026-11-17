'use strict';
const fs=require('node:fs');const path=require('node:path');
const {classifyTransaction}=require('./zethosphere-classifier.cjs');
const {mergeEvents,deliverPending}=require('./zethosphere-alerts.cjs');
const RPC=process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com';
const ADDRESSES=(process.env.ZETHO_MONITOR_ADDRESSES||'').split(',').map(x=>x.trim()).filter(Boolean);
const MINT=(process.env.ZETHO_MINT_ADDRESS||'').trim();
const OUT=path.join(process.cwd(),'monitor-data'),HISTORY=path.join(OUT,'events.json'),STATUS=path.join(OUT,'status.json');
const now=()=>new Date().toISOString();
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return d;}};
async function rpc(method,params){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{const res=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});if(!res.ok)throw Error('RPC HTTP '+res.status);const body=await res.json();if(body.error)throw Error(body.error.message||'RPC error');return body.result;}
 finally{clearTimeout(timer);}
}
async function scanAddress(address,cursor,mint){
 const found=[];let before;let cursorFound=!cursor;let pages=0;
 while(!cursorFound&&pages<5){
  const opts={limit:100,commitment:'confirmed'};if(before)opts.before=before;
  const sigs=await rpc('getSignaturesForAddress',[address,opts]);pages++;
  if(!sigs.length)break;
  for(const s of sigs){if(s.signature===cursor){cursorFound=true;break;}found.push(s);}
  before=sigs[sigs.length-1].signature;
  if(sigs.length<100)break;
 }
 if(!cursor){const first=await rpc('getSignaturesForAddress',[address,{limit:1,commitment:'confirmed'}]);return {events:[],cursor:first[0]?.signature||null,baseline:true,gap:false};}
 if(!cursorFound&&found.length>=500) return {events:[],cursor:before,baseline:false,gap:true};
 const events=[];
 for(const s of found.reverse()){
  if(s.err){events.push({id:s.signature,signature:s.signature,address,severity:'WARNING',type:'FAILED_TRANSACTION',message:'Transaction failed on chain',slot:s.slot,blockTime:s.blockTime||null,evidence:'https://explorer.solana.com/tx/'+s.signature});continue;}
  const tx=await rpc('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
  if(tx)events.push({...classifyTransaction(tx,s.signature,mint),address});
  else events.push({id:s.signature,signature:s.signature,address,severity:'WARNING',type:'TRANSACTION_UNAVAILABLE',message:'Signature found but transaction details were unavailable',slot:s.slot,blockTime:s.blockTime||null,evidence:'https://explorer.solana.com/tx/'+s.signature});
 }
 const newest=found[0]?.signature||cursor;
 return {events,cursor:newest,baseline:false,gap:!cursorFound};
}
async function main(){
 fs.mkdirSync(OUT,{recursive:true});
 const old=read(HISTORY,{events:[],cursors:{}});const state=Array.isArray(old)?{events:old,cursors:{}}:old;
 const checks=[],incoming=[];let rpcOk=false;let scanGap=false;
 try{await rpc('getHealth',[]);rpcOk=true;checks.push({name:'Solana RPC health',status:'PASS',checkedAt:now()});}
 catch(e){checks.push({name:'Solana RPC health',status:'ERROR',detail:e.message,checkedAt:now()});}
 if(!MINT)checks.push({name:'Official ZETHO mint',status:'WAITING',detail:'Verified mainnet mint address is not configured'});
 else if(rpcOk){
  try{const info=await rpc('getAccountInfo',[MINT,{encoding:'jsonParsed',commitment:'confirmed'}]);const parsed=info?.value?.data?.parsed;if(!parsed||parsed.type!=='mint')throw Error('Address is not a parsed SPL mint account');const d=parsed.info;
   checks.push({name:'Mint account',status:'PASS',checkedAt:now(),decimals:d.decimals,supply:d.supply,mintAuthority:d.mintAuthority,freezeAuthority:d.freezeAuthority});
   if(d.freezeAuthority)incoming.push({severity:'CRITICAL',type:'FREEZE_AUTHORITY_PRESENT',message:'Freeze authority is present on monitored mint',address:MINT,evidence:'https://explorer.solana.com/address/'+MINT});
   if(d.mintAuthority)incoming.push({severity:'WARNING',type:'MINT_AUTHORITY_PRESENT',message:'Mint authority remains active on monitored mint',address:MINT,evidence:'https://explorer.solana.com/address/'+MINT});
  }catch(e){checks.push({name:'Mint account',status:'ERROR',detail:e.message,checkedAt:now()});}
 }
 if(!ADDRESSES.length)checks.push({name:'Project address register',status:'WAITING',detail:'No independently verified project addresses configured'});
 else if(rpcOk){
  for(const address of ADDRESSES){
   try{const result=await scanAddress(address,state.cursors[address]||null,MINT);state.cursors[address]=result.cursor;incoming.push(...result.events);scanGap=scanGap||result.gap;checks.push({name:'Address '+address,status:result.gap?'ERROR':'PASS',detail:result.baseline?'Initial cursor established; older activity not imported':result.gap?'History gap: cursor not found within scan window':'Confirmed signatures scanned',checkedAt:now(),newEvents:result.events.length});}
   catch(e){checks.push({name:'Address '+address,status:'ERROR',detail:e.message,checkedAt:now()});}
  }
 }
 state.events=mergeEvents(state.events,incoming,1000);
 const delivery=await deliverPending(state.events);
 const failedDelivery=delivery.some(x=>!x.sent);
 const emailConfigured=!!(process.env.RESEND_API_KEY&&process.env.ALERT_EMAIL_TO&&process.env.ALERT_EMAIL_FROM);
 checks.push({name:'Email alert delivery',status:!emailConfigured?'WAITING':failedDelivery?'ERROR':'PASS',detail:!emailConfigured?'Configure RESEND_API_KEY, ALERT_EMAIL_TO and ALERT_EMAIL_FROM':failedDelivery?'One or more alerts remain queued for retry':'No pending critical/warning alerts; provider accepted configured sends',checkedAt:now()});
 const requiredOk=rpcOk&&!!MINT&&ADDRESSES.length>0&&emailConfigured&&checks.filter(c=>['Solana RPC health','Mint account','Project address register'].some(n=>c.name===n)||c.name.startsWith('Address ')).every(c=>c.status==='PASS')&&!scanGap;
 const health=checks.some(c=>c.status==='ERROR')||failedDelivery?'DEGRADED':requiredOk?'OPERATIONAL':'WAITING_FOR_CONFIGURATION';
 const status={generatedAt:now(),lastSuccessfulScan:requiredOk?now():(read(STATUS,{}).lastSuccessfulScan||null),mode:'READ_ONLY',health,rpcEndpoint:RPC.includes('api-key')?'configured provider endpoint':'public Solana RPC endpoint',mintConfigured:!!MINT,addressesConfigured:ADDRESSES.length>0,emailConfigured,checks,events:state.events.slice(0,100),pendingAlerts:state.events.filter(e=>e.deliveryPending&&!e.alertedAt).length,notice:health==='OPERATIONAL'?'Configured read-only checks completed. This is not a guarantee against compromise.':'Monitoring is not fully operational. Missing configuration, failed checks or delivery problems must not be interpreted as safe.'};
 fs.writeFileSync(HISTORY,JSON.stringify(state,null,2)+'\n');fs.writeFileSync(STATUS,JSON.stringify(status,null,2)+'\n');
 console.log(JSON.stringify({health,checks:checks.length,newEvents:incoming.length,deliveryAttempts:delivery.length,pendingAlerts:status.pendingAlerts}));
 if(health==='DEGRADED')process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
