'use strict';
const crypto=require('node:crypto');
function fingerprint(event){return crypto.createHash('sha256').update([event.signature||'',event.type||'',event.address||'',event.message||''].join('|')).digest('hex');}
function mergeEvents(existing,incoming,max=1000){
 const map=new Map((existing||[]).map(e=>[e.fingerprint||fingerprint(e),e]));
 for(const event of incoming||[]){const fp=fingerprint(event);if(!map.has(fp))map.set(fp,{...event,fingerprint:fp,firstSeenAt:event.firstSeenAt||new Date().toISOString(),acknowledged:false});}
 return [...map.values()].sort((a,b)=>String(b.firstSeenAt).localeCompare(String(a.firstSeenAt))).slice(0,max);
}
function pendingAlerts(events){return (events||[]).filter(e=>['CRITICAL','WARNING'].includes(e.severity)&&!e.alertedAt&&!e.acknowledged);}
async function sendEmail(event,env=process.env){
 if(!env.RESEND_API_KEY||!env.ALERT_EMAIL_TO||!env.ALERT_EMAIL_FROM) return {sent:false,reason:'Email not configured'};
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.ALERT_EMAIL_FROM,to:[env.ALERT_EMAIL_TO],subject:'[ZETHOSPHERE '+event.severity+'] '+event.type,text:[event.message,'Detected: '+(event.firstSeenAt||new Date().toISOString()),'Signature: '+(event.signature||'N/A'),'Address: '+(event.address||'N/A'),'Evidence: '+(event.evidence||'N/A'),'This is an automated read-only monitoring alert. Verify independently before acting.'].join('\\n')})});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error('Email provider HTTP '+response.status+': '+(body.message||'delivery request failed'));
 return {sent:true,id:body.id||null};
}
async function deliverPending(events,env=process.env){
 const results=[];
 for(const event of pendingAlerts(events)){
  try{const r=await sendEmail(event,env);if(r.sent){event.alertedAt=new Date().toISOString();event.deliveryId=r.id;}else{event.deliveryPending=true;event.deliveryReason=r.reason;}results.push({id:event.id||event.signature,sent:r.sent});}
  catch(e){event.deliveryPending=true;event.deliveryReason=e.message;results.push({id:event.id||event.signature,sent:false,error:e.message});}
 }
 return results;
}
module.exports={fingerprint,mergeEvents,pendingAlerts,sendEmail,deliverPending};
