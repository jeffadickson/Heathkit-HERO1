// Shift test: the ROM assembled $4000 lower must behave identically in every scenario.
// Compares display, RAM, motor positions and speech once per emulated second.
global.M6800=require('../emulator/cpu6800.js');const HW=require('../emulator/herohw.js');const fs=require('fs');const crypto=require('crypto');
const SHIFT=parseInt(process.argv[2]||'-16384');
const orig=new Uint8Array(fs.readFileSync(__dirname+'/../HERO.ROM')),sh=new Uint8Array(fs.readFileSync(__dirname+'/../build/shifted.bin'));
function machine(img,shift){const base=0xE000+shift;return ()=>{const h=new HW(new Uint8Array(8192));h.clockBase=Date.UTC(1982,11,6,15,0,0);
  h.read=function(a){if(a<0x1000)return this.ram[a];if(a>=0xFFF8)return img[a-0xE000];if(a>=base&&a<base+0x2000)return img[a-base];if(a>=0xC000&&a<0xC400)return this.ioRead(a);return 0;};
  h.powerOn();return h;};}
function trace(img,shift){const log=[];const S=require('../tests/scenarios.js')(h=>{log.push(h._sc+'@'+Math.round(h._t)+' d='+h.latch.join('.')+' r='+crypto.createHash('md5').update(Buffer.concat([h.ram.subarray(0,0x400),h.ram.subarray(0x600,0xEE0)])).digest('hex').slice(0,8)+' m='+h.steps.map(v=>v.toFixed(2)).join(',')+' s='+h.speechText.join('.')+' h='+(h.halted||''));});
  const mk=machine(img,shift);for(const n of Object.keys(S)){S[n](()=>{const h=mk();h._sc=n;return h;},a=>a+shift);}return log;}
// User programs at $0400-$05FF carry relocated ROM addresses, so they are left out of the hash.
// RAM above $0EE0 holds return addresses into the ROM, which legitimately differ by the shift
const a=trace(orig,0),b=trace(sh,SHIFT);let bad=0;
for(let i=0;i<Math.max(a.length,b.length);i++)if(a[i]!==b[i]){if(bad++<3)console.log('DIFF\n orig:  '+a[i]+'\n shift: '+b[i]);}
console.log(bad?'shift test FAILED ('+bad+' of '+a.length+' checkpoints differ)':'shift test PASSED ('+a.length+' checkpoints across all scenarios, shift '+SHIFT+')');process.exit(bad?1:0);
