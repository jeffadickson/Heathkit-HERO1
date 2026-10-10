global.M6800=require('../src/cpu6800.js');const Hero=require('../src/hero.js');const P=require('../src/programs.js');
const SEG2C={};const T={0x7E:'0',0x30:'1',0x6D:'2',0x79:'3',0x33:'4',0x5B:'5',0x5F:'6',0x70:'7',0x7F:'8',0x7B:'9',0x77:'A',0x1F:'b',0x4E:'C',0x3D:'d',0x4F:'E',0x47:'F',0x37:'H',0x0E:'L',0x05:'r',0x3B:'y',0x1D:'o',0x0F:'t',0x00:' ',0x01:'-',0x67:'P',0x15:'n',0x3E:'U'};
const disp=h=>h.seg.map(s=>(T[s&0x7F]||'?')+(s&0x80?'.':'')).join('');
function load(h,p){for(const a in p.bytes)p.bytes[a].forEach((b,i)=>h.ram[+a+i]=b);}
function go(h,p){const H4=v=>v.toString(16).toUpperCase().padStart(4,'0');h.key('RESET');h.key(p.robot?0xA:1);h.key(0xD);for(const c of H4(p.org))h.key(parseInt(c,16));}
function tick(h,s){for(let t=0;t<s;t+=1/60)h.advance(1/60);}
const logs=[];
for(const p of P){const h=new Hero();h.listeners.push((t,m)=>{if(t==='log'||t==='speech'&&m)logs.push(p.id+': '+t+' '+m);});load(h,p);go(h,p);
 if(p.id==='keyhead'){tick(h,0.2);h.key(1);tick(h,6);console.log('keyhead head after 1 =',h.pos[6].toString(16));h.key(3);tick(h,8);console.log('after 3 =',h.pos[6].toString(16));}
 else if(p.id==='clap'){tick(h,3);const x0=h.world.y;h.clap();tick(h,3);console.log('clap: moved',(x0-h.world.y).toFixed(1),'px, drive busy',h.busy(0));h.clap();tick(h,2);const y1=h.world.y;tick(h,1);console.log('after 2nd clap moved further',(y1-h.world.y).toFixed(1),'busy',h.busy(0));}
 else if(p.id==='trigger'){tick(h,2);h.trigger();tick(h,1);h.trigger();tick(h,1);console.log('trigger count $40 =',h.ram[0x40],'disp',disp(h),'head',h.pos[6].toFixed(1));}
 else if(p.id==='hello'){tick(h,0.5);console.log('hello disp machine:',disp(h));h.key('RESET');h.key(0xA);h.key(0xD);[0,3,3,5].forEach(k=>h.key(k));tick(h,0.1);console.log('robot after 0.1s:',disp(h));tick(h,1);console.log('robot after 1.1s:',disp(h));}
 else if(p.id==='sonar'){tick(h,25);console.log('sonar disp',disp(h),'mode',h.mode,'head',h.pos[6].toFixed(0),'range',h.ram[0x11],'hits',h.ram[0x10]);}
 else {tick(h,40);console.log(p.id,'mode',h.mode,'disp',disp(h),'pos',h.pos.map(v=>v.toFixed(0)).join(','),'xy',h.world.x.toFixed(0),h.world.y.toFixed(0));}
}
console.log(logs.slice(0,40).join('\n'));
