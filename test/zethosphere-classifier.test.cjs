'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {classifyTransaction}=require('../scripts/zethosphere-classifier.cjs');
const make=(type)=>({slot:10,blockTime:100,transaction:{message:{instructions:[{program:'spl-token',programId:'Token111',parsed:{type,info:{}}}]}},meta:{fee:5000,preTokenBalances:[],postTokenBalances:[],innerInstructions:[],logMessages:[]}});
test('classifies mint, authority, burn and transfer instructions',()=>{
 assert.equal(classifyTransaction(make('mintTo'),'sig1','mint').severity,'CRITICAL');
 assert.equal(classifyTransaction(make('setAuthority'),'sig2','mint').type,'TOKEN_AUTHORITY_CHANGE');
 assert.equal(classifyTransaction(make('burn'),'sig3','mint').type,'TOKEN_BURN');
 assert.equal(classifyTransaction(make('transfer'),'sig4','mint').type,'TOKEN_TRANSFER');
});
test('preserves signature, slot and explorer evidence',()=>{const e=classifyTransaction(make('transfer'),'abc','mint');assert.equal(e.signature,'abc');assert.equal(e.slot,10);assert.match(e.evidence,/explorer.solana.com/);});
test('uses safe generic classification for unknown instructions',()=>assert.equal(classifyTransaction(make('unknown'),'sig','mint').type,'ACCOUNT_ACTIVITY'));
