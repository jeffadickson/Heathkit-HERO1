// Measured register log: run every scenario on the real ROM with a shadow call stack keyed on SP.
// For each ROM routine entry: calls, registers written (value changed by an instruction executed
// inside the call, including callees), registers whose exit value differs from entry, branch coverage.
// Interrupt handlers are logged as their own frames; the interrupted routine is paused meanwhile.
global.M6800=require('../emulator/cpu6800.js');const HW=require('../emulator/herohw.js');const fs=require('fs');
const rom=new Uint8Array(fs.readFileSync(__dirname+'/../HERO.ROM'));
const stats={};       // entry -> {calls, written:Set, exitDiff:Set, cycles:[min,max], stackMax}
const branches={};    // addr -> {taken, not}
const COND=new Set([0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F]);
function st(e){return stats[e]||(stats[e]={calls:0,written:new Set(),exitDiff:new Set(),flagsW:new Set(),cyc:[1e12,0],stack:0,exits:new Set()});}
function mk(){
  const h=new HW(rom);h.clockBase=Date.UTC(1982,11,6,15,0,0);const c=h.cpu;const frames=[];let cyc=0,irqDepth=0;const acc=[0,0,0,0,0,0,0,0];const above=d=>{let t=0;for(let j=d+1;j<acc.length;j++)t+=acc[j];return t;};
  const regs=()=>({A:c.a,B:c.b,X:c.x,CC:c.getCC()});
  const enter=(entry,kind)=>{frames.push({entry,sp:c.sp,in:regs(),w:new Set(),fl:new Set(),c0:cyc,d0:irqDepth,i0:above(irqDepth),kind,minsp:c.sp});};
  const leave=(how)=>{const f=frames.pop();if(f.kind==='irq')irqDepth--;const s=st(f.entry);s.calls++;const out=regs();
    for(const r of ['A','B','X'])if(out[r]!==f.in[r])s.exitDiff.add(r);
    f.w.forEach(r=>s.written.add(r));f.fl.forEach(x=>s.flagsW.add(x));const d=(cyc-f.c0)-(above(f.d0)-f.i0);s.cyc[0]=Math.min(s.cyc[0],d);s.cyc[1]=Math.max(s.cyc[1],d);
    s.stack=Math.max(s.stack,f.sp-f.minsp);s.exits.add(how);
    if(frames.length){const p=frames[frames.length-1];if(f.kind!=='irq'){f.w.forEach(r=>p.w.add(r));f.fl.forEach(x=>p.fl.add(x));p.minsp=Math.min(p.minsp,f.minsp);}}};
  const step=c.step.bind(c);
  const FL=['C','V','Z','N','I','H'];
  c.step=function(){const pc=c.pc,op=c.bus.read(pc),pa=c.a,pb=c.b,px=c.x,pc0=c.getCC();
    const r=step();cyc+=r;acc[Math.min(irqDepth,7)]+=r;
    const n=frames.length;
    if(n){const f=frames[n-1];if(c.sp<f.minsp)f.minsp=c.sp;
      if(c.a!==pa)f.w.add('A');if(c.b!==pb)f.w.add('B');if(c.x!==px)f.w.add('X');
      const d=(c.getCC()^pc0)&0x3F;if(d)for(let i=0;i<6;i++)if(d&(1<<i))f.fl.add(FL[i]);}
    if(pc>=0xE000&&COND.has(op)){const t=branches[pc]||(branches[pc]={taken:0,not:0});if(c.pc===pc+2)t.not++;else t.taken++;}
    if(op===0xBD||op===0xAD||op===0x8D){if(c.pc>=0xE000)enter(c.pc,'call');else enter(c.pc,'ramhook');}
    else if(op===0x39){if(frames.length&&c.sp<=frames[frames.length-1].sp){const sp0=frames[frames.length-1].sp;leave('RTS dispatch');enter(c.pc,'dispatch');frames[frames.length-1].sp=sp0;}else while(frames.length&&c.sp>frames[frames.length-1].sp)leave('RTS');}
    else if(op===0x3B){while(frames.length&&c.sp>frames[frames.length-1].sp)leave(frames[frames.length-1].kind==='irq'?'RTI':'RTI-unwound');}
    return r;};
  const irq=c.irq.bind(c),nmi=c.nmi.bind(c);
  c.irq=function(){const was=c.i;const ok=irq();if(ok){frames.push({entry:c.pc,sp:c.sp,in:regs(),w:new Set(),fl:new Set(),c0:cyc,d0:irqDepth+1,i0:above(irqDepth+1),kind:'irq',minsp:c.sp});irqDepth++;}return ok;};
  c.nmi=function(){nmi();frames.length=0;irqDepth=0;};
  const reset=h.reset.bind(h);h.reset=function(){frames.length=0;irqDepth=0;reset();};
  return h;}
const S=require('../tests/scenarios.js')();
for(const n of Object.keys(S)){S[n](mk,a=>a);}
const out={};for(const [e,s] of Object.entries(stats)){if(+e<0xE000)continue;out[(+e).toString(16).toUpperCase().padStart(4,'0')]={calls:s.calls,written:[...s.written].sort(),exitDiff:[...s.exitDiff].sort(),flags:'HINZVC'.split('').filter(x=>s.flagsW.has(x)).join(''),cycles:s.cyc,stack:s.stack,exits:[...s.exits]};}
const br={};for(const [a,t] of Object.entries(branches))br[(+a).toString(16).toUpperCase()]=t;
fs.writeFileSync(__dirname+'/../build/measured.json',JSON.stringify({routines:out,branches:br},null,0));
console.log('measured routines:',Object.keys(out).length,'conditional branches seen:',Object.keys(br).length);
