'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {classifyTransaction}=require('../scripts/zethosphere-classifier.cjs');
const make=(type)=>({slot:10,blockTime:100,transaction:{message:{instructions:[{program:'spl-token',programId:'Token111',parsed:{type,info:{mint:'mint',account:'mint'}}}]}},meta:{fee:5000,preTokenBalances:[],postTokenBalances:[],innerInstructions:[],logMessages:[]}});
test('classifies mint, authority, burn and transfer instructions',()=>{
 assert.equal(classifyTransaction(make('mintTo'),'sig1','mint').severity,'CRITICAL');
 assert.equal(classifyTransaction(make('setAuthority'),'sig2','mint').type,'TOKEN_AUTHORITY_CHANGE');
 assert.equal(classifyTransaction(make('burn'),'sig3','mint').type,'TOKEN_BURN');
 assert.equal(classifyTransaction(make('transfer'),'sig4','mint').type,'TOKEN_TRANSFER');
});
test('preserves signature, slot and explorer evidence',()=>{const e=classifyTransaction(make('transfer'),'abc','mint');assert.equal(e.signature,'abc');assert.equal(e.slot,10);assert.match(e.evidence,/explorer.solana.com/);});
test('uses safe generic classification for unknown instructions',()=>assert.equal(classifyTransaction(make('unknown'),'sig','mint').type,'ACCOUNT_ACTIVITY'));

test('ordinary transfers are informational and large transfers escalate',()=>{
 const ordinary=make('transfer');ordinary.transaction.message.instructions[0].parsed.info.amount='1000';
 const large=make('transfer');large.transaction.message.instructions[0].parsed.info.amount='100000000000000';
 assert.equal(classifyTransaction(ordinary,'small','mint').severity,'INFO');
 assert.equal(classifyTransaction(large,'large','mint').severity,'WARNING');
});
test('unrelated token authority changes are not classified as ZETHO critical events',()=>{
 const tx=make('setAuthority');tx.transaction.message.instructions[0].parsed.info.account='differentMint';tx.transaction.message.instructions[0].parsed.info.mint='differentMint';
 assert.equal(classifyTransaction(tx,'other','mint').severity,'INFO');
});

test('large unrelated-token transfers do not trigger a ZETHO large-transfer alert',()=>{
 const tx=make('transfer');
 tx.transaction.message.instructions[0].parsed.info={mint:'otherMint',account:'otherTokenAccount',amount:'100000000000000'};
 tx.meta.preTokenBalances=[
  {accountIndex:1,mint:'mint',uiTokenAmount:{amount:'1000',decimals:9}},
  {accountIndex:2,mint:'mint',uiTokenAmount:{amount:'0',decimals:9}}
 ];
 tx.meta.postTokenBalances=[
  {accountIndex:1,mint:'mint',uiTokenAmount:{amount:'0',decimals:9}},
  {accountIndex:2,mint:'mint',uiTokenAmount:{amount:'1000',decimals:9}}
 ];
 const event=classifyTransaction(tx,'mixed-token-transaction','mint');
 assert.equal(event.type,'TOKEN_TRANSFER');
 assert.equal(event.severity,'INFO');
});
