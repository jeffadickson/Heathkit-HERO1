global.M6800=require('../emulator/cpu6800.js');const Hero=require('../web/src/hero.js');const fs=require('fs');
const rom=fs.readFileSync(__dirname+'/../HERO.ROM');const h=new Hero();h.read=a=>a>=0xE000?rom[a-0xE000]:0;
const [s,e,mode]=[parseInt(process.argv[2],16),parseInt(process.argv[3],16),process.argv[4]||'n'];let a=s,r=mode==='r';
while(a<e){const d=h.disasm(a,r);const bs=[];for(let i=0;i<d.len;i++)bs.push(Hero.hex(h.read(a+i),2));console.log(Hero.hex(a,4),bs.join(' ').padEnd(24),d.text);const op=h.read(a);if(!r&&op===0x3F)r=true;else if(r&&op===0x83)r=false;a+=d.len;}
