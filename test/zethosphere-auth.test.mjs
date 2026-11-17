import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {passwordMatches,validSession,handle} from '../workers/founder-auth.mjs';
const enc=new TextEncoder();
const b64u=b=>Buffer.from(b).toString('base64url');
async function hash(password){const salt=webcrypto.getRandomValues(new Uint8Array(16));const key=await webcrypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);const bits=await webcrypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},key,256);return b64u(salt)+':'+b64u(bits);}
test('password verification accepts correct password and rejects wrong password',async()=>{const stored=await hash('correct horse battery staple');assert.equal(await passwordMatches('correct horse battery staple',stored),true);assert.equal(await passwordMatches('wrong',stored),false);});
test('login refuses to operate without server secrets',async()=>{const r=await handle(new Request('https://example.test/api/founder/login',{method:'POST',body:JSON.stringify({password:'x'})}),{});assert.equal(r.status,503);});
test('unauthenticated session endpoint is false',async()=>{const r=await handle(new Request('https://example.test/api/founder/session'),{});assert.deepEqual(await r.json(),{authenticated:false});});
test('unknown route returns 404',async()=>{const r=await handle(new Request('https://example.test/unknown'),{});assert.equal(r.status,404);});

test('successful login issues a secure session cookie accepted by the session endpoint',async()=>{
 const password='correct horse battery staple with extras';
 const env={FOUNDER_PASSWORD_HASH:await hash(password),SESSION_SIGNING_SECRET:'a-long-independent-session-signing-secret',AUTH_LIMITS:{get:async()=>null,put:async()=>{},delete:async()=>{}}};
 const login=await handle(new Request('https://example.test/api/founder/login',{method:'POST',headers:{'content-type':'application/json',Origin:'https://example.test'},body:JSON.stringify({password})}),env);
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie');
 assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
 const session=await handle(new Request('https://example.test/api/founder/session',{headers:{Cookie:cookie.split(';')[0]}}),env);
 assert.deepEqual(await session.json(),{authenticated:true});
});
test('login rate limit blocks repeated attempts',async()=>{
 const env={FOUNDER_PASSWORD_HASH:'bad',SESSION_SIGNING_SECRET:'secret',AUTH_LIMITS:{get:async()=> '10'}};
 const r=await handle(new Request('https://example.test/api/founder/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'wrong'})}),env);
 assert.equal(r.status,429);
});

test('founder monitor status endpoint denies unauthenticated requests',async()=>{
 const r=await handle(new Request('https://example.test/api/founder/monitor-status'),{});
 assert.equal(r.status,401);
});
test('founder monitor status endpoint requires configured source after authentication',async()=>{
 const password='correct horse battery staple with extras';
 const env={FOUNDER_PASSWORD_HASH:await hash(password),SESSION_SIGNING_SECRET:'a-long-independent-session-signing-secret',AUTH_LIMITS:{get:async()=>null,put:async()=>{},delete:async()=>{}}};
 const login=await handle(new Request('https://example.test/api/founder/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})}),env);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const r=await handle(new Request('https://example.test/api/founder/monitor-status',{headers:{Cookie:cookie}}),env);
 assert.equal(r.status,503);
});
