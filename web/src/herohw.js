/* HERO 1 hardware emulation: runs the real 8 KB system ROM on the 6808 core.
 * Device behavior is reconstructed from the ET-18 Technical Manual, the
 * schematics, the owners' FAQ port map, and the ROM's own use of each port. */
(function (root) {
"use strict";
var M6800 = root.M6800 || (typeof require !== "undefined" ? require("./cpu6800.js") : null);

var CLOCK = 3579545 / 4;               // E clock: 3.579545 MHz crystal / 4
var TICK_HZ = 1024;                     // real-time clock interrupt (manual: $0EFC counts at 1,024 Hz)
// keypad wiring, recovered from the ROM's scan routine at $F73C: key -> [port, bit]
var KEYMAP = { 0xF:[3,0], 0xC:[3,1], 9:[3,2], 6:[3,3], 3:[3,4], 0xE:[5,0], 0xB:[5,1], 8:[5,2], 5:[5,3], 2:[5,4],
               0xD:[6,0], 0xA:[6,1], 7:[6,2], 4:[6,3], 1:[6,4], 0:[6,5] };
var MOT = ["Drive", "Extend", "Shoulder", "Wrist rotate", "Wrist pivot", "Gripper", "Head", "Steering"];
var PH = ["EH3","EH2","EH1","PA0","DT","A1","A2","ZH","AH2","I3","I2","I1","M","N","B","V","CH","SH","Z","AW1","NG","AH1","OO1","OO","L","K","J","H","G","F","D","S","A","AY","Y1","UH3","AH","P","O","I","U","Y","T","R","E","W","AE","AE1","AW2","UH2","UH1","UH","O2","O1","IU","U1","THV","TH","ER","EH","E1","AW","PA1","STOP"];
var PDUR = [59,71,121,47,47,71,103,90,71,55,80,121,103,80,71,71,71,121,71,146,121,146,103,185,103,80,47,71,71,103,55,90,185,65,80,47,250,103,185,103,185,103,71,90,185,80,185,103,90,71,103,185,80,121,59,90,80,71,146,185,121,250,185,47];

function hex(v, n) { return (v >>> 0).toString(16).toUpperCase().padStart(n, "0"); }

function HeroHW(rom) {
  var self = this;
  this.rom = rom;                       // Uint8Array(8192) for $E000-$FFFF
  this.ram = new Uint8Array(0x1000);
  this.cpu = new M6800({ read: function (a) { return self.read(a); }, write: function (a, v) { self.write(a, v); } });
  this.cpu.onIllegal = function (op, pc) { self.halted = "Illegal opcode $" + hex(op, 2) + " at $" + hex(pc, 4); return 2; };
  this.listeners = [];
  // motors: physical step counts. stepper groups share phase lines; C2C0 bits 6/7 pick which motor of each pair is driven
  // physical positions in the ROM's units; travel limits from the manual's "Data in Memory" table
  this.limits = [null, [0, 0x98], [0, 0x86], [0, 0x93], [0, 0xA5], [0, 0x75], [0, 0xC2], [0, 0x93]];
  this.steps = [0, 0x4C, 0x43, 0x49, 0x52, 0x3A, 0x61, 0x49];   // power up somewhere mid-travel; Initialize (3,1) homes them
  this.lastAng = {};
  this.world = { x: 160, y: 300, th: 0, trail: [], walls: [[0,0,640,0],[640,0,640,380],[640,380,0,380],[0,380,0,0],[430,110,520,110],[520,110,520,180],[520,180,430,180],[430,180,430,110],[90,60,170,60],[170,60,170,95],[170,95,90,95],[90,95,90,60]] };
  this.powerOn();
}
var H = HeroHW.prototype;
HeroHW.hex = hex; HeroHW.MOT = MOT; HeroHW.PH = PH; HeroHW.CLOCK = CLOCK;

H.emit = function (t, m) { this.listeners.forEach(function (f) { f(t, m); }); };

H.powerOn = function () {
  this.ram.fill(0);
  // RAM is battery-backed through sleep, so start as a robot that was initialized earlier:
  // the ROM's position table ($0000-$0006) agrees with where the motors physically are.
  for (var m = 1; m < 8; m++) this.ram[m - 1] = Math.round(this.steps[m]);
  this.out = { 0xC260: 0, 0xC280: 0, 0xC2A0: 0x3F, 0xC2C0: 0, 0xC2E0: 0, 0xC300: 0, 0xC240: 0, 0xC220: 0 };
  this.flags = 0; this.mask = 0;
  this.keysDown = {};
  this.latch = [0, 0, 0, 0, 0, 0];      // display segment latches, one byte per digit
  this.sleepSwitch = false; this.triggerHeld = false;
  this.time = 0; this.cycles = 0; this.tickAcc = 0; this.debt = 0;
  this.speechBusyUntil = 0; this.speechText = []; this.speechClearAt = 0;
  this.sonarAt = 0; this.sonarRange = 0;
  this.wheelAcc = 0; this.driveSpeed = 0;
  this.light = 0x60; this.sound = 0x10; this.soundUntil = 0;
  this.halted = null;
  if (this.clockBase === undefined) this.clockBase = Date.now();   // MSM5832 runs from your computer's clock
  this.reset();
};
H.reset = function () { this.halted = null; this.cpu.waiting = false; this.cpu.reset(); this.emit("reset"); };
H.nmi = function () { this.cpu.nmi(); };   // ABORT button

/* ---------------- bus ---------------- */
H.read = function (a) {
  if (a < 0x1000) return this.ram[a];
  if (a >= 0xE000) return this.rom[a - 0xE000];
  if (a >= 0xC000 && a < 0xC400) return this.ioRead(a);
  return 0xFF;
};
H.write = function (a, v) {
  if (a < 0x1000) { this.ram[a] = v; return; }
  if (a >= 0xC000 && a < 0xC400) this.ioWrite(a, v);
};

H.ioRead = function (a) {
  if (a >= 0xC000 && a <= 0xC007) {                       // keypad rows on A0-A2 (active low)
    var v = 0xFF, row = a & 7;
    for (var k in this.keysDown) { var m = KEYMAP[k]; if (m && m[0] === row) v &= ~(1 << m[1]); }
    return v;
  }
  switch (a) {
    case 0xC200: return this.flags;
    case 0xC220: return this.sonarRange;
    case 0xC240: return this.senseLevel();
    case 0xC260: return this.limitInputs();
    case 0xC280: return (this.sleepSwitch ? 0 : 0x02) | (this.triggerHeld ? 0 : 0x01) | 0xF0 | 0x0C;
    case 0xC300: return 0xF0 | this.clockRead();
    case 0xC2A0: return 0xFF;
  }
  return 0xFF;
};
H.ioWrite = function (a, v) {
  if (a >= 0xC100 && a < 0xC170) {                        // display: one 74LS259 per digit, data bit 0
    var d = 6 - ((a >> 4) & 0xF), q = a & 7;
    if (d >= 0 && d < 6) { if (v & 1) this.latch[d] |= (1 << q); else this.latch[d] &= ~(1 << q); }
    return;
  }
  if (a === 0xC200) { this.flags &= v; this.mask = v; return; }
  var old = this.out[a];
  this.out[a] = v;
  if (a === 0xC260 || a === 0xC280 || a === 0xC2C0) this.steppers();
  if (a === 0xC2C0 && (v & 0x20) && !(old & 0x20)) this.speechStrobe();
  if (a === 0xC2A0) this.emit("drive", v);
};

/* ---------------- interrupts ---------------- */
H.raise = function (bit) { if (this.mask & bit) this.flags |= bit; };
H.irqLine = function () { return (this.flags & this.mask) !== 0; };

/* ---------------- steppers ---------------- */
// phase nibble -> electrical angle; a change of +-45/90 degrees is one (half) step
// two bipolar coils: A on bits 3/2, B on bits 1/0 (ROM sequence 0110,0101,1001,1010)
function phaseAngle(n) {
  var x = ((n & 4) ? 1 : 0) - ((n & 8) ? 1 : 0), y = ((n & 1) ? 1 : 0) - ((n & 2) ? 1 : 0);
  if (!x || !y) return null; return Math.atan2(y, x);
}
var DRIVE_COUNTS_PER_SPEED = 0.6, DRIVE_IN_PER_COUNT = 0.25;
var STEPS_PER_UNIT = [0, 32, 32, 8, 8, 4, 32, 8];   // phase steps per ROM position unit, measured from the ROM's own counting
H.steppers = function () {
  var c260 = this.out[0xC260], c280 = this.out[0xC280], sel = this.out[0xC2C0];
  var groups = [
    [7, c260 >> 4],                                                          // steering
    [(sel & 0x40) ? 4 : -1, c260 & 15], [(sel & 0x80) ? 3 : -1, c260 & 15],  // pivot / wrist rotate
    [(sel & 0x40) ? 1 : -1, c280 >> 4], [(sel & 0x80) ? 6 : -1, c280 >> 4],  // extend / head
    [(sel & 0x40) ? 5 : -1, c280 & 15], [(sel & 0x80) ? 2 : -1, c280 & 15]   // gripper / shoulder
  ];
  for (var i = 0; i < groups.length; i++) {
    var m = groups[i][0], ang = phaseAngle(groups[i][1]);
    if (m < 0 || ang === null) continue;
    var last = this.lastAng[m];
    if (last !== undefined) {
      var d = ang - last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      var st = Math.round(d / (Math.PI / 2));
      if (st) this.stepMotor(m, st);
    }
    this.lastAng[m] = ang;
  }
};
H.stepMotor = function (m, st) {
  var L = this.limits[m], p = this.steps[m] + st / STEPS_PER_UNIT[m];
  if (L) p = Math.max(L[0], Math.min(L[1], p));        // mechanical stops: the motor stalls
  this.steps[m] = p;
  this.lastMoved = m;
};
// limit switch inputs on $C260 (active low), bit 0 = speech request (high when the SC-01 wants a phoneme)
H.limitInputs = function () {
  var v = 0xFF, s = this.steps, L = this.limits;
  if (s[7] >= L[7][1] - 0.01) v &= ~0x40; if (s[7] <= L[7][0] + 0.01) v &= ~0x08;     // steering CW / CCW
  if (s[6] <= L[6][0] + 0.01) v &= ~0x10; if (s[6] >= L[6][1] - 0.01) v &= ~0x02;     // head CCW / CW
  var am = this.lastMoved >= 1 && this.lastMoved <= 5 ? this.lastMoved : -1;
  if (am > 0) { if (s[am] >= L[am][1] - 0.01) v &= ~0x20; if (s[am] <= L[am][0] + 0.01) v &= ~0x04; }
  if (this.time < this.speechBusyUntil) v &= ~0x01;
  return v;
};

/* ---------------- speech (SC-01) ---------------- */
H.speechStrobe = function () {
  var p = this.out[0xC240] & 0x3F;
  this.speechBusyUntil = this.time + PDUR[p] / 1000;
  this.speechClearAt = this.speechBusyUntil + 0.8;
  if (p !== 0x3F) { this.speechText.push(PH[p]); this.emit("speech", this.speechText.join(" ")); }
};

/* ---------------- sense board, sonar, clock ---------------- */
H.senseLevel = function () {
  var light = (this.out[0xC2C0] & 0x10) !== 0;
  return light ? this.light : this.sound;
};
H.clap = function () { this.sound = 0xC0; this.soundUntil = this.time + 0.25; };
H.clockRead = function () {
  var r = this.out[0xC2C0] & 15, d = new Date(this.clockBase + this.time * 1000), h = d.getHours();
  var vals = [d.getSeconds() % 10, Math.floor(d.getSeconds() / 10), d.getMinutes() % 10, Math.floor(d.getMinutes() / 10),
    h % 10, Math.floor(h / 10) | 8, d.getDay(), d.getDate() % 10, Math.floor(d.getDate() / 10),
    (d.getMonth() + 1) % 10, Math.floor((d.getMonth() + 1) / 10), d.getFullYear() % 10, Math.floor(d.getFullYear() / 10) % 10, 0, 0, 0];
  return vals[r] & 15;
};
H.headAngle = function () { var L = this.limits[6]; return ((this.steps[6] - (L[0] + L[1]) / 2) / (L[1] - L[0])) * (350 * Math.PI / 180); };
H.steerAngle = function () { var L = this.limits[7]; return ((this.steps[7] - (L[0] + L[1]) / 2) / ((L[1] - L[0]) / 2)) * 1.3; };
H.sonarDistance = function () {
  var W = this.world, ang = W.th + this.headAngle(), ox = W.x, oy = W.y, dx = Math.sin(ang), dy = -Math.cos(ang), best = Infinity;
  W.walls.forEach(function (w) {
    var ex = w[2] - w[0], ey = w[3] - w[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) return;
    var t = ((w[0] - ox) * ey - (w[1] - oy) * ex) / den, u = ((w[0] - ox) * dy - (w[1] - oy) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  });
  return best / 40 * 12;
};

/* ---------------- drive ---------------- */
H.driveTick = function (dt) {
  // $C2A0: bit 7 direction (0 = forward), bit 6 motor on, bits 5-0 PWM speed; the ROM ramps speed one step every 32 ms
  var v = this.out[0xC2A0], spd = (v & 0x40) ? (v & 0x3F) : 0;
  var dir = (v & 0x80) ? -1 : 1;
  this.driveSpeed = spd;
  if (!spd) return;
  var counts = spd * DRIVE_COUNTS_PER_SPEED * dt;               // encoder counts per second (illustrative scale)
  this.wheelAcc += counts;
  while (this.wheelAcc >= 1) {
    this.wheelAcc -= 1; this.raise(0x40);
    var W = this.world, ds = dir * DRIVE_IN_PER_COUNT * (40 / 12), phi = this.steerAngle();
    var nx = W.x + ds * Math.cos(phi) * Math.sin(W.th), ny = W.y - ds * Math.cos(phi) * Math.cos(W.th);
    if (this.hitsWall(nx, ny, 28)) { this.wheelAcc = 0; break; }      // stalled against something
    W.th += ds * Math.sin(phi) / 30; W.x = nx; W.y = ny;
    var t = W.trail, last = t[t.length - 1];
    if (!last || Math.hypot(last[0] - W.x, last[1] - W.y) > 3) { t.push([W.x, W.y]); if (t.length > 800) t.shift(); }
  }
};
H.hitsWall = function (x, y, r) {
  return this.world.walls.some(function (w) {
    var dx = w[2] - w[0], dy = w[3] - w[1], l2 = dx * dx + dy * dy, t = Math.max(0, Math.min(1, ((x - w[0]) * dx + (y - w[1]) * dy) / l2));
    return Math.hypot(x - (w[0] + t * dx), y - (w[1] + t * dy)) < r;
  });
};

/* ---------------- keypad and buttons ---------------- */
H.press = function (k) {                    // key held ~80 ms of machine time
  if (k === "RESET") { this.reset(); return; }
  this.keysDown[k] = this.time + 0.08;
};
H.trigger = function () { this.raise(0x20); };
H.motion = function () { if (this.out[0xC2E0] & 0x04) { this.raise(0x02); return true; } return false; };
H.sonarOn = function () { return (this.out[0xC2E0] & 0x02) !== 0; };
H.displayOn = function () { return (this.out[0xC2E0] & 0x10) !== 0; };

/* ---------------- main loop ---------------- */
H.advance = function (dt) {
  dt = Math.min(dt, 0.1);
  var c = this.cpu, budget = dt * CLOCK + this.debt, perTick = CLOCK / TICK_HZ;
  while (budget > 0) {
    if (this.halted) break;
    // devices advance in 1/1024 s slices
    if (this.tickAcc <= 0) {
      this.tickAcc += perTick;
      this.time += 1 / TICK_HZ;
      this.raise(0x10);
      for (var k in this.keysDown) if (this.time > this.keysDown[k]) delete this.keysDown[k];
      if (this.soundUntil && this.time > this.soundUntil) { this.sound = 0x10; this.soundUntil = 0; }
      if (this.speechClearAt && this.time > this.speechClearAt) { this.speechText = []; this.speechClearAt = 0; this.emit("speech", ""); }
      if ((this.out[0xC2E0] & 0x02) && this.time - this.sonarAt > 0.06) {           // sonar powered: ping
        this.sonarAt = this.time; var d = this.sonarDistance();
        if (d >= 4 && d <= 96) { this.sonarRange = Math.min(255, Math.round(d / 0.4)); this.raise(0x01); }
      }
      this.driveTick(1 / TICK_HZ);
    }
    if (this.irqLine() && !c.i) c.irq();
    var cy = c.step();
    if (c.waiting && !this.irqLine()) cy = Math.max(cy, Math.ceil(this.tickAcc));
    budget -= cy; this.tickAcc -= cy; this.cycles += cy;
  }
  this.debt = Math.min(0, budget);
};

root.HeroHW = HeroHW;
if (typeof module !== "undefined") module.exports = HeroHW;
})(typeof window !== "undefined" ? window : globalThis);
