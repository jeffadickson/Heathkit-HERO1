global.M6800=require('../src/cpu6800.js');const Hero=require('../src/hero.js');const P=require('../src/programs.js');
const h=new Hero();for(const p of P){h.ram.fill(0);for(const a in p.bytes)p.bytes[a].forEach((b,i)=>h.ram[+a+i]=b);
let a=p.org,r=p.robot;console.log('--',p.id);const end=Math.max(...Object.keys(p.bytes).map(k=>+k+p.bytes[k].length));
const first=+Object.keys(p.bytes)[0], blocks=Object.keys(p.bytes).map(Number);
for(const s of blocks){a=s;if(s!==p.org&&p.id==='trigger')r=false;while(a<s+p.bytes[s].length){const d=h.disasm(a,r);console.log(Hero.hex(a,4),d.text);if(!r&&h.read(a)===0x3F)r=true;else if(r&&h.read(a)===0x83)r=false;a+=d.len;}}}
