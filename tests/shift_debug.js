// Find the first time the shifted ROM jumps to an unshifted ROM address, and show how it got there.
global.M6800=require('../emulator/cpu6800.js');const HW=require('../emulator/herohw.js');const fs=require('fs');
const SHIFT=-16384,img=new Uint8Array(fs.readFileSync(__dirname+'/../build/shifted.bin'));const base=0xE000+SHIFT;
const h=new HW(new Uint8Array(8192));
h.read=function(a){if(a<0x1000)return this.ram[a];if(a>=0xFFF8)return img[a-0xE000];if(a>=base&&a<base+0x2000)return img[a-base];if(a>=0xC000&&a<0xC400)return this.ioRead(a);return 0;};
const reads=[];const hist=[];const st=h.cpu.step.bind(h.cpu);let done=false;
h.cpu.step=function(){const pc=this.pc;hist.push(pc);if(hist.length>40)hist.shift();
 if(!done&&pc>=0xE000&&pc<0xFFF8){done=true;console.log('jumped to unshifted $'+pc.toString(16)+' ; last PCs (orig addr = +1000):');console.log(hist.map(x=>(x+0x4000).toString(16)).join(' '));}
 return st();};
h.powerOn();
const run=s=>{for(let t=0;t<s&&!done;t+=1/60)h.advance(1/60);};
run(2);const p=[0x72,0x05,0x00,0xCC,0xD8,0x20,0x3A];p.forEach((b,i)=>h.ram[0x400+i]=b);[0x1B,0x02,0xFF].forEach((b,i)=>h.ram[0x500+i]=b);
for(const k of [0xA,0xD,0,4,0,0]){h.press(k);run(0.25);}run(10);
if(!done)console.log('no stray jump; halted:',h.halted);
