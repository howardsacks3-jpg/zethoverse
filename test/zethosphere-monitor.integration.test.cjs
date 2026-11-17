'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const ROOT=path.join(__dirname,'..');
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

test('monitor baselines safely, advances to newest signature, preserves cursor on history gaps',async(t)=>{
 let mintSupply='5000000000',deploymentSlot=12;
 let signatures=[{signature:'oldSignature',slot:1,blockTime:1000}];
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const q=JSON.parse(body);let result=null;
  if(q.method==='getHealth')result='ok';
  else if(q.method==='getGenesisHash')result=GENESIS;
  else if(q.method==='getAccountInfo'&&q.params[0]==='22222222222222222222222222222222')result={value:{data:{parsed:{type:'program',info:{programData:'33333333333333333333333333333333'}}}}};
  else if(q.method==='getAccountInfo'&&q.params[0]==='33333333333333333333333333333333')result={value:{data:{parsed:{type:'programData',info:{slot:deploymentSlot,upgradeAuthority:null}}}}};
  else if(q.method==='getAccountInfo')result={value:{data:{parsed:{type:'mint',info:{decimals:9,supply:mintSupply,mintAuthority:null,freezeAuthority:null}}}}};
  else if(q.method==='getSignaturesForAddress'){
   const opts=q.params[1]||{};
   if(opts.limit===1)result=signatures.slice(0,1);
   else{
    const index=opts.before?signatures.findIndex(s=>s.signature===opts.before):-1;
    const start=opts.before?(index<0?signatures.length:index+1):0;
    result=signatures.slice(start,start+(opts.limit||100));
   }
  }else if(q.method==='getTransaction')result={slot:2,blockTime:2000,transaction:{message:{instructions:[{program:'spl-token',programId:'TokenProgram',parsed:{type:'transfer',info:{mint:'11111111111111111111111111111111',amount:'1000'}}}]}},meta:{fee:5000,err:null,preTokenBalances:[],postTokenBalances:[{accountIndex:1,mint:'11111111111111111111111111111111',uiTokenAmount:{amount:'1000',decimals:9}}],innerInstructions:[],logMessages:[]}};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zethosphere-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const address='11111111111111111111111111111111';
 const env={...process.env,SOLANA_RPC_URL:'http://127.0.0.1:'+server.address().port,ZETHO_MINT_ADDRESS:address,ZETHO_MONITOR_ADDRESSES:address,ZETHO_PROGRAM_ADDRESSES:'22222222222222222222222222222222'};
 const run=(expected=0)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(ROOT,'scripts/zethosphere-monitor.cjs')],{cwd:dir,env});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>code===expected?resolve(stdout):reject(new Error(stderr||stdout||'monitor exited '+code+', expected '+expected)));});
 const readState=()=>JSON.parse(fs.readFileSync(path.join(dir,'monitor-data/events.json'),'utf8'));
 const readStatus=()=>JSON.parse(fs.readFileSync(path.join(dir,'monitor-data/status.json'),'utf8'));

 await run();
 assert.equal(readState().cursors[address],'oldSignature');
 assert.equal(readState().events.length,0);

 signatures=[
  {signature:'newestA',slot:3,blockTime:3000},
  {signature:'newestB',slot:2,blockTime:2000},
  {signature:'oldSignature',slot:1,blockTime:1000}
 ];
 mintSupply='5000000001';deploymentSlot=13;
 await run(1);
 let state=readState();
 assert.equal(state.cursors[address],'newestA','cursor must advance to the newest signature, not the oldest newly found signature');
 assert.equal(state.events.filter(e=>e.type==='TOKEN_TRANSFER').length,2);
 assert.ok(state.events.some(e=>e.type==='MINT_SUPPLY_INCREASED'&&e.severity==='CRITICAL'));
 assert.ok(state.events.some(e=>e.type==='PROGRAM_UPGRADE_DETECTED'&&e.severity==='CRITICAL'));
 let status=readStatus();
 assert.equal(status.health,'DEGRADED');
 assert.equal(status.pendingAlerts,2);
 assert.equal(status.mintConfigured,true);
 assert.equal(status.addressesConfigured,true);
 assert.equal(status.programsConfigured,true);
 assert.equal(status.emailConfigured,false);
 assert.equal(status.emailDeliveryVerified,false);

 // A repeat scan must find the newest cursor immediately and not replay activity.
 await run(1);
 state=readState();
 assert.equal(state.cursors[address],'newestA');
 assert.equal(state.events.filter(e=>e.type==='TOKEN_TRANSFER').length,2);

 // If the cursor falls outside the 500-signature window, preserve it and report a gap.
 signatures=Array.from({length:500},(_,i)=>({signature:'gap'+i,slot:1000-i,blockTime:4000-i}));
 await run(1);
 state=readState();
 assert.equal(state.cursors[address],'newestA','a history gap must never advance the saved cursor');
 status=readStatus();
 assert.equal(status.health,'DEGRADED');
 assert.ok(status.checks.some(c=>c.name==='Address '+address&&c.status==='ERROR'));
});
