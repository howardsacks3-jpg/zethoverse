'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ADDRESSES = (process.env.ZETHO_MONITOR_ADDRESSES || '').split(',').map(x=>x.trim()).filter(Boolean);
const MINT = (process.env.ZETHO_MINT_ADDRESS || '').trim();
const OUT = path.join(process.cwd(), 'monitor-data');
const HISTORY = path.join(OUT, 'events.json');
const STATUS = path.join(OUT, 'status.json');
const now = new Date().toISOString();
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return fallback; } };
async function rpc(method, params) {
  const res = await fetch(RPC, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if (!res.ok) throw new Error('RPC HTTP '+res.status);
  const body=await res.json();
  if(body.error) throw new Error(body.error.message || 'RPC error');
  return body.result;
}
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  const previous=readJson(HISTORY,[]);
  const events=[];
  const checks=[];
  let rpcOk=false;
  try { await rpc('getHealth',[]); rpcOk=true; }
  catch(e){ checks.push({name:'Solana RPC health',status:'ERROR',detail:e.message}); }
  if(rpcOk) checks.push({name:'Solana RPC health',status:'PASS',detail:'RPC responded to getHealth'});
  if(!MINT) checks.push({name:'Official ZETHO mint',status:'WAITING',detail:'Set ZETHO_MINT_ADDRESS after mainnet mint verification'});
  else {
    try {
      const info=await rpc('getAccountInfo',[MINT,{encoding:'jsonParsed',commitment:'confirmed'}]);
      const parsed=info?.value?.data?.parsed;
      if(!parsed || parsed.type!=='mint') throw new Error('Address is not a parsed SPL mint account');
      const d=parsed.info;
      checks.push({name:'Mint account',status:'PASS',detail:'Mint account readable',decimals:d.decimals,supply:d.supply,mintAuthority:d.mintAuthority,freezeAuthority:d.freezeAuthority});
      if(d.freezeAuthority) events.push({severity:'CRITICAL',type:'FREEZE_AUTHORITY_PRESENT',message:'Freeze authority is present on monitored mint',evidence:MINT});
      if(d.mintAuthority) events.push({severity:'WARNING',type:'MINT_AUTHORITY_PRESENT',message:'Mint authority remains active',evidence:MINT});
    } catch(e){ checks.push({name:'Mint account',status:'ERROR',detail:e.message}); }
  }
  if(!ADDRESSES.length) checks.push({name:'Project address register',status:'WAITING',detail:'Set ZETHO_MONITOR_ADDRESSES to comma-separated verified public addresses'});
  for(const address of ADDRESSES){
    try{
      const signatures=await rpc('getSignaturesForAddress',[address,{limit:20,commitment:'confirmed'}]);
      const old=new Set(previous.map(x=>x.signature));
      for(const tx of signatures||[]){
        if(old.has(tx.signature)) continue;
        events.push({severity:tx.err?'WARNING':'INFO',type:tx.err?'TRANSACTION_FAILED':'NEW_ADDRESS_ACTIVITY',message:tx.err?'Failed transaction observed':'New confirmed activity on monitored address',address,signature:tx.signature,slot:tx.slot,blockTime:tx.blockTime||null,evidence:'https://explorer.solana.com/tx/'+tx.signature});
      }
      checks.push({name:'Address '+address,status:'PASS',detail:'Fetched recent signatures',count:signatures.length});
    }catch(e){checks.push({name:'Address '+address,status:'ERROR',detail:e.message});}
  }
  const merged=[...events,...previous].slice(0,500);
  const status={generatedAt:now,mode:'READ_ONLY',health:checks.some(x=>x.status==='ERROR')?'DEGRADED':(!MINT||!ADDRESSES.length?'WAITING_FOR_CONFIGURATION':'OPERATIONAL'),rpcConfigured:true,mintConfigured:!!MINT,addressesConfigured:ADDRESSES.length>0,checks,events:events.slice(0,100),notice:'No address is monitored until explicitly configured. No data here is a security guarantee.'};
  fs.writeFileSync(HISTORY,JSON.stringify(merged,null,2)+'\n');
  fs.writeFileSync(STATUS,JSON.stringify(status,null,2)+'\n');
  console.log(JSON.stringify({health:status.health,checks:checks.length,newEvents:events.length}));
  if(checks.some(x=>x.status==='ERROR')) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
