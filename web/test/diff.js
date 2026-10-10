const M6800=require('../src/cpu6800.js');const fs=require('fs');
function hash(s,a){let h=(s^Math.imul(a,0x9E3779B1))>>>0;h^=h>>>16;h=Math.imul(h,0x85EBCA6B)>>>0;h^=h>>>13;h=Math.imul(h,0xC2B2AE35)>>>0;h^=h>>>16;return h>>>0;}
const lines=fs.readFileSync(0,'utf8').trim().split('\n');const bad={};let nbad=0;
const H=(v,n)=>v.toString(16).toUpperCase().padStart(n,'0');
for(const L of lines){const f=L.split(' ');const i=+f[0];const seed=(Math.imul(i,2654435761)+1)>>>0;
 const over=new Map(),writes=[];const cpu=new M6800({read:a=>over.has(a)?over.get(a):hash(seed,a)&0xFF,write:(a,v)=>{writes.push(H(a,4)+':'+H(v,2));over.set(a,v);}});
 const op=parseInt(f[1],16);cpu.pc=hash(seed,1)&0xFFFF;over.set(cpu.pc,op);
 cpu.a=hash(seed,2)&0xFF;cpu.b=hash(seed,3)&0xFF;cpu.x=hash(seed,4)&0xFFFF;cpu.sp=hash(seed,5)&0xFFFF;cpu.setCC(hash(seed,6)&0x3F);
 cpu.step();
 let ccmask=0x3F; if(op===0x19)ccmask&=~0x02; // DAA: V undefined
 const got=[H(cpu.pc,4),H(cpu.a,2),H(cpu.b,2),H(cpu.x,4),H(cpu.sp,4),H(cpu.getCC()&ccmask,2),String(writes.length),...writes.slice(0,8)].join(' ');
 const exp=[f[2],f[3],f[4],f[5],f[6],H(parseInt(f[7],16)&ccmask,2),...f.slice(8)].join(' ');
 if(got!==exp){nbad++;(bad[f[1]]=bad[f[1]]||[]).push('exp '+exp+' | got '+got+' | cc0 '+H(hash(seed,6)&0x3F,2)+' a0 '+H(hash(seed,2)&0xFF,2)+' b0 '+H(hash(seed,3)&0xFF,2));}}
console.log('tests',lines.length,'mismatches',nbad);for(const k of Object.keys(bad).sort())console.log(k,bad[k].length,bad[k][0]);
