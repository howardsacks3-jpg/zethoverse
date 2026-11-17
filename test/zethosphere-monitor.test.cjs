'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../scripts/zethosphere-monitor.cjs'),'utf8');
test('monitor is read-only and contains no signing or transfer methods',()=>{
 for(const forbidden of ['sendTransaction','signTransaction','transferChecked','setAuthority']) assert.equal(script.includes(forbidden),false,forbidden);
});
test('monitor requires explicit verified mint and address configuration',()=>{
 assert.match(script,/ZETHO_MINT_ADDRESS/);
 assert.match(script,/ZETHO_MONITOR_ADDRESSES/);
 assert.match(script,/WAITING_FOR_CONFIGURATION/);
});
test('monitor records evidence and timestamps',()=>{
 assert.match(script,/generatedAt/);
 assert.match(script,/evidence/);
 assert.match(script,/events.json/);
});
test('monitor uses confirmed Solana reads',()=>{
 assert.match(script,/getSignaturesForAddress/);
 assert.match(script,/commitment:'confirmed'/);
});
