const COOKIE='zetho_founder_session';
const encoder=new TextEncoder();
const b64u=(bytes)=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const unb64u=(s)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function hmac(secret,data){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);return new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(data)));}
async function passwordMatches(password,stored){
 const [salt,expected]=String(stored||'').split(':');if(!salt||!expected)return false;
 const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:unb64u(salt),iterations:310000,hash:'SHA-256'},key,256);
 return b64u(bits)===expected;
}
async function sessionToken(env){
 const payload=b64u(encoder.encode(JSON.stringify({sub:'founder',exp:Date.now()+8*60*60*1000})));
 return payload+'.'+b64u(await hmac(env.SESSION_SIGNING_SECRET,payload));
}
async function validSession(request,env){
 const raw=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 if(!raw)return false;const [payload,sig]=raw.split('.');if(!payload||!sig)return false;
 const expected=b64u(await hmac(env.SESSION_SIGNING_SECRET,payload));if(sig!==expected)return false;
 try{const data=JSON.parse(new TextDecoder().decode(unb64u(payload)));return data.sub==='founder'&&data.exp>Date.now();}catch{return false;}
}
function response(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});}
async function handle(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/api/founder/login'&&request.method==='POST'){
  if(!env.FOUNDER_PASSWORD_HASH||!env.SESSION_SIGNING_SECRET)return response({error:'Authentication is not configured'},503);
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const key='login:'+ip;const count=Number(await env.AUTH_LIMITS?.get(key)||0);
  if(count>=10)return response({error:'Too many attempts'},429);
  let body;try{body=await request.json();}catch{return response({error:'Invalid request'},400);}
  if(typeof body.password!=='string'||body.password.length>1024)return response({error:'Invalid credentials'},401);
  if(!await passwordMatches(body.password,env.FOUNDER_PASSWORD_HASH)){
   if(env.AUTH_LIMITS)await env.AUTH_LIMITS.put(key,String(count+1),{expirationTtl:900});
   return response({error:'Invalid credentials'},401);
  }
  if(env.AUTH_LIMITS)await env.AUTH_LIMITS.delete(key);
  const token=await sessionToken(env);
  return response({authenticated:true},{headers:{'set-cookie':COOKIE+'='+token+'; HttpOnly; Secure; SameSite=Strict; Path=/api/founder; Max-Age=28800'}});
 }
 if(url.pathname==='/api/founder/logout'&&request.method==='POST')return response({authenticated:false},{headers:{'set-cookie':COOKIE+'=; HttpOnly; Secure; SameSite=Strict; Path=/api/founder; Max-Age=0'}});
 if(url.pathname==='/api/founder/session'&&request.method==='GET')return response({authenticated:await validSession(request,env)});
 return response({error:'Not found'},404);
}
export {passwordMatches,validSession,handle};
export default {fetch:handle};
