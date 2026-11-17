'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {sendEmail}=require('../scripts/zethosphere-alerts.cjs');
test('email delivery fails closed when credentials are missing',async()=>{const r=await sendEmail({severity:'CRITICAL',type:'TEST',message:'x'},{});assert.deepEqual(r,{sent:false,reason:'Email not configured'});});
test('email delivery rejects provider errors',async()=>{const original=global.fetch;global.fetch=async()=>({ok:false,status:401,json:async()=>({message:'unauthorized'})});try{await assert.rejects(()=>sendEmail({severity:'CRITICAL',type:'TEST',message:'x'},{RESEND_API_KEY:'bad',ALERT_EMAIL_TO:'a@example.com',ALERT_EMAIL_FROM:'b@example.com'}),/HTTP 401/);}finally{global.fetch=original;}});
