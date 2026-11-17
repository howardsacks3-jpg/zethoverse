import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {passwordMatches,validSession,handle} from '../workers/founder-auth.mjs';
globalThis.crypto=webcrypto;
const enc=new TextEncoder();
const b64u=b=>Buffer.from(b).toString('base64url');
async function hash(password){const salt=webcrypto.getRandomValues(new Uint8Array(16));const key=await webcrypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);const bits=await webcrypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},key,256);return b64u(salt)+':'+b64u(bits);}
test('password verification accepts correct password and rejects wrong password',async()=>{const stored=await hash('correct horse battery staple');assert.equal(await passwordMatches('correct horse battery staple',stored),true);assert.equal(await passwordMatches('wrong',stored),false);});
test('login refuses to operate without server secrets',async()=>{const r=await handle(new Request('https://example.test/api/founder/login',{method:'POST',body:JSON.stringify({password:'x'})}),{});assert.equal(r.status,503);});
test('unauthenticated session endpoint is false',async()=>{const r=await handle(new Request('https://example.test/api/founder/session'),{});assert.deepEqual(await r.json(),{authenticated:false});});
test('unknown route returns 404',async()=>{const r=await handle(new Request('https://example.test/unknown'),{});assert.equal(r.status,404);});
