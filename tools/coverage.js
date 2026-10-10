// Record every executed ROM instruction address across the scripted scenarios.
global.M6800=require('../emulator/cpu6800.js');const HW=require('../emulator/herohw.js');const fs=require('fs');
const rom=new Uint8Array(fs.readFileSync(__dirname+'/../HERO.ROM'));const exec=new Map();
function mk(){const h=new HW(rom);const st=h.cpu.step.bind(h.cpu);h.cpu.step=function(){const pc=this.pc;if(pc>=0xE000)exec.set(pc,(exec.get(pc)||0)+1);return st();};return h;}
const S=require('../tests/scenarios.js')();
for(const n of Object.keys(S)){const b=exec.size;const h=S[n](mk,a=>a);console.log(n.padEnd(14),'new',exec.size-b);}
fs.writeFileSync(__dirname+'/../build-coverage.json',JSON.stringify([...exec.entries()]));console.log('executed instruction addresses',exec.size);
