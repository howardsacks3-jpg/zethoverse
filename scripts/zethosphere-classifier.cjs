'use strict';
const SWAP_PROGRAMS = new Set([
 '675kPX9MHTjS2zt1qfr1NYHuzef2y8wQvVj7V4dV8V','whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',

]);
function instructionsOf(tx){return (tx?.transaction?.message?.instructions||[]).concat(...((tx?.meta?.innerInstructions||[]).map(x=>x.instructions||[])));}
function classifyTransaction(tx, signature, mint){
 const instructions=instructionsOf(tx), parsed=instructions.map(i=>i.parsed).filter(Boolean);
 const programIds=instructions.map(i=>i.programId).filter(Boolean);
 const logs=tx?.meta?.logMessages||[];
 const types=parsed.map(p=>p.type||'');
 const targetMint= mint || null;
 const targetTokenMovement=(tx?.meta?.postTokenBalances||[]).some(b=>!targetMint||b.mint===targetMint) ||
   (tx?.meta?.preTokenBalances||[]).some(b=>!targetMint||b.mint===targetMint);
 let type='ACCOUNT_ACTIVITY', severity='INFO', message='Confirmed activity observed';
 const targetInstruction=!targetMint||parsed.some(p=>p.info?.mint===targetMint||p.info?.account===targetMint);
 const targetEvent=targetInstruction||targetTokenMovement;
 const authority=targetEvent&&types.some(t=>t==='setAuthority');
 const minting=targetEvent&&types.some(t=>t==='mintTo'||t==='mintToChecked');
 const burning=targetEvent&&types.some(t=>t==='burn'||t==='burnChecked');
 const swap=(programIds.some(p=>SWAP_PROGRAMS.has(p)) || logs.some(l=>/Instruction: (Swap|SwapV2)/i.test(l)))&&(!targetMint||targetTokenMovement);
 const transfers=parsed.filter(p=>p.type==='transfer'||p.type==='transferChecked');
 if(authority){type='TOKEN_AUTHORITY_CHANGE';severity='CRITICAL';message='Token authority change instruction detected';}
 else if(minting){type='TOKEN_MINT';severity='CRITICAL';message='Token mint instruction detected';}
 else if(burning){type='TOKEN_BURN';severity='WARNING';message='Token burn instruction detected';}
 else if(swap){type='SWAP';severity='INFO';message='Swap-like program invocation detected; amounts require balance-delta verification';}
 else if(transfers.length&&targetTokenMovement){type='TOKEN_TRANSFER';severity='WARNING';message='Token transfer involving monitored mint detected';}
 else if(tx?.meta?.err){type='FAILED_TRANSACTION';severity='WARNING';message='Transaction failed on chain';}
 const pre=tx?.meta?.preTokenBalances||[], post=tx?.meta?.postTokenBalances||[];
 const deltas=[];
 for(const b of post){const before=pre.find(x=>x.accountIndex===b.accountIndex&&x.mint===b.mint);const a=BigInt(b.uiTokenAmount?.amount||'0');const z=BigInt(before?.uiTokenAmount?.amount||'0');const delta=a-z;if(delta!==0n)deltas.push({accountIndex:b.accountIndex,mint:b.mint,delta:delta.toString(),decimals:b.uiTokenAmount?.decimals??0});}
 return {id:signature,signature,type,severity,message,slot:tx?.slot??null,blockTime:tx?.blockTime??null,fee:tx?.meta?.fee??null,err:tx?.meta?.err??null,programIds:[...new Set(programIds)],tokenDeltas:deltas,evidence:'https://explorer.solana.com/tx/'+signature,classificationConfidence:swap?'program-invocation':(types.length?'parsed-instruction':'balance-and-signature'),targetMintObserved:targetTokenMovement};
}
module.exports={classifyTransaction};
