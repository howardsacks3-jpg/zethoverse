import {webcrypto} from 'node:crypto';
const password=process.env.FOUNDER_PASSWORD;
if(!password||password.length<20)throw new Error('Set FOUNDER_PASSWORD to a strong password of at least 20 characters in your local shell environment; do not pass it as a command-line argument.');
const salt=webcrypto.getRandomValues(new Uint8Array(16));
const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
const bits=await webcrypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},key,256);
const b64u=b=>Buffer.from(b).toString('base64url');
console.log(b64u(salt)+':'+b64u(bits));
