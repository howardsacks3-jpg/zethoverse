'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {mergeEvents,pendingAlerts,deliverPending}=require('../scripts/zethosphere-alerts.cjs');
test('deduplicates repeated observations by stable fingerprint',()=>{const a={signature:'s1',type:'TOKEN_MINT',severity:'CRITICAL'};assert.equal(mergeEvents([a],[a]).length,1);});
test('queues critical and warning alerts but not informational events',()=>{const a=mergeEvents([],[{signature:'1',severity:'CRITICAL'},{signature:'2',severity:'WARNING'},{signature:'3',severity:'INFO'}]);assert.equal(pendingAlerts(a).length,2);});
test('keeps delivery pending when email credentials are absent',async()=>{const a=mergeEvents([],[{signature:'1',severity:'CRITICAL'}]);const r=await deliverPending(a,{});assert.equal(r[0].sent,false);assert.equal(a[0].deliveryPending,true);});
test('does not resend an already acknowledged event',()=>{const a=mergeEvents([],[{signature:'1',severity:'CRITICAL'}]);a[0].acknowledged=true;assert.equal(pendingAlerts(a).length,0);});

test('failed delivery stays queued and is marked accepted after a later successful retry',async()=>{
 const events=mergeEvents([],[{signature:'retry-me',severity:'CRITICAL',type:'TEST',message:'retry'}]);
 const original=global.fetch;
 try{
  global.fetch=async()=>({ok:false,status:503,json:async()=>({message:'temporary outage'})});
  await deliverPending(events,{RESEND_API_KEY:'key',ALERT_EMAIL_TO:'a@example.com',ALERT_EMAIL_FROM:'b@example.com'});
  assert.equal(events[0].deliveryPending,true);assert.equal(events[0].alertedAt,undefined);
  global.fetch=async()=>({ok:true,status:200,json:async()=>({id:'email-123'})});
  await deliverPending(events,{RESEND_API_KEY:'key',ALERT_EMAIL_TO:'a@example.com',ALERT_EMAIL_FROM:'b@example.com'});
  assert.ok(events[0].alertedAt);assert.equal(events[0].deliveryId,'email-123');
 }finally{global.fetch=original;}
});
