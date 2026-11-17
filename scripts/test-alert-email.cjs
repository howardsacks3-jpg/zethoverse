'use strict';
const {sendEmail}=require('./zethosphere-alerts.cjs');
(async()=>{
 const to=process.env.ALERT_EMAIL_TO,from=process.env.ALERT_EMAIL_FROM;
 if(!process.env.RESEND_API_KEY||!to||!from)throw new Error('Set RESEND_API_KEY, ALERT_EMAIL_TO and ALERT_EMAIL_FROM as GitHub Actions secrets/variables before testing delivery.');
 const result=await sendEmail({severity:'INFO',type:'DELIVERY_TEST',message:'ZETHOSPHERE email delivery test. This confirms the Resend API accepted a test message.',firstSeenAt:new Date().toISOString(),evidence:'https://zethoverse.com/zethosphere.html'});
 if(!result.sent)throw new Error('Email provider did not accept test message');
 console.log(JSON.stringify({accepted:true,providerMessageId:result.id,to}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
