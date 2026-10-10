/* HERO 1 machine model: 6808 + 4 KB RAM + high-level emulation of the 8 KB system ROM.
 * The ROM image is not publicly available, so its documented services
 * (executive/monitor keypad modes, display subroutines, Robot Interpreter,
 * interrupt dispatch) are implemented here in JavaScript, following the
 * ET-18 Technical Manual. Requires M6800 (cpu6800.js). */
(function (root) {
"use strict";
var M6800 = root.M6800 || (typeof require !== "undefined" ? require("./cpu6800.js") : null);

var CLOCK = 3579545 / 4;                 // 3.58 MHz crystal, divided by four inside the 6808
var ROBOT_OVERHEAD = 740;                // extra cycles per interpreted instruction (manual: 6000-pass loop 41 s vs 0.3 s)
var MOT = ["Drive", "Extend", "Shoulder", "Wrist rotate", "Wrist pivot", "Gripper", "Head", "Steering"];
var MAXP = [1023, 0x98, 0x86, 0x93, 0xA5, 0x75, 0xC2, 0x93];
var MID  = [0, 0x4C, 0x43, 0x49, 0x52, 0x3A, 0x61, 0x49];   // positions after ZERO (illustrative mid-travel)
var SPEED = { arm: [8, 8, 16, 32], drive: [18, 18, 36, 72] }; // units per second for ss = 00,01,10,11
var DRIVE_IN = 0.2;                       // inches per drive unit (illustrative)
var PH = ["EH3","EH2","EH1","PA0","DT","A1","A2","ZH","AH2","I3","I2","I1","M","N","B","V","CH","SH","Z","AW1","NG","AH1","OO1","OO","L","K","J","H","G","F","D","S","A","AY","Y1","UH3","AH","P","O","I","U","Y","T","R","E","W","AE","AE1","AW2","UH2","UH1","UH","O2","O1","IU","U1","THV","TH","ER","EH","E1","AW","PA1","STOP"];
// SC-01 phoneme durations in ms (Votrax data sheet, nominal)
var PDUR = [59,71,121,47,47,71,103,90,71,55,80,121,103,80,71,71,71,121,71,146,121,146,103,185,103,80,47,71,71,103,55,90,185,65,80,47,250,103,185,103,185,103,71,90,185,80,185,103,90,71,103,185,80,121,59,90,80,71,146,185,121,250,185,47];
var HEXSEG = [0x7E,0x30,0x6D,0x79,0x33,0x5B,0x5F,0x70,0x7F,0x7B,0x77,0x1F,0x4E,0x3D,0x4F,0x47];
// segment bits per the manual's Figure 1: bit6 a, 5 b, 4 c, 3 d, 2 e, 1 f, 0 g, 7 decimal point
var TXT = { r:0x05, E:0x4F, A:0x77, d:0x3D, y:0x3B, o:0x1D, b:0x1F, t:0x0F, P:0x67, "6":0x5F, "8":0x7F, "0":0x7E, " ":0, "-":0x01, n:0x15, H:0x37, L:0x0E, S:0x5B, U:0x3E, C:0x4E, c:0x0D, I:0x30 };
var ROM = { INCH:0xF777, OUTCH:0xF7C8, OUTHEX:0xF7B5, OUTBYT:0xF7AD, CLRDIS:0xF65B, REDIS:0xF64E, OUTSTR:0xF7E5, DSPLAY:0xF6F9, IRQRET:0xFFE0 };
var ROBOT_OPS = {0x02:1,0x03:1,0x04:1,0x05:1,0x1C:2,0x1D:2,0x1E:2,0x1F:2,0x21:1,0x3A:1,0x41:1,0x42:1,0x45:1,0x4B:1,0x4E:1,0x51:1,0x52:1,0x55:1,0x5B:1,0x5E:1,
  0x61:2,0x62:2,0x71:3,0x72:3,0x83:1,0x87:3,0x8F:3,0xC3:3,0xCC:3,0xD3:3,0xDC:3,0xE3:2,0xEC:2,0xF3:3,0xFC:3,0xFD:8};

function Hero() {
  var self = this;
  this.ram = new Uint8Array(0x1000);
  this.cpu = new M6800({ read: function (a) { return self.read(a); }, write: function (a, v) { self.write(a, v); } });
  this.cpu.onIllegal = function (op, pc) { self.crash("Illegal 6800 opcode $" + hex(op, 2) + " at $" + hex(pc, 4) + ". Robot Language opcodes need the interpreter: precede them with 3F (SWI)."); return 2; };
  this.listeners = [];
  this.world = { x: 160, y: 300, th: 0, trail: [], walls: [[0,0,640,0],[640,0,640,380],[640,380,0,380],[0,380,0,0],[430,110,520,110],[520,110,520,180],[520,180,430,180],[430,180,430,110],[90,60,170,60],[170,60,170,95],[170,95,90,95],[90,95,90,60]] };
  this.powerOn();
}
var H = Hero.prototype;
function hex(v, n) { return (v >>> 0).toString(16).toUpperCase().padStart(n, "0"); }
Hero.hex = hex; Hero.MOT = MOT; Hero.MAXP = MAXP; Hero.PH = PH; Hero.ROM = ROM; Hero.ROBOT_OPS = ROBOT_OPS; Hero.CLOCK = CLOCK;

H.emit = function (type, msg) { this.listeners.forEach(function (f) { f(type, msg); }); };
H.log = function (m) { this.emit("log", m); };

H.powerOn = function () {
  this.ram.fill(0);
  for (var k = 0x30; k <= 0x38; k += 3) this.ram[k] = 0x3A;   // user keys: return to executive until programmed
  this.pos = MID.slice(); this.tgt = MID.slice(); this.spd = [0,0,0,0,0,0,0,0];
  this.armQueue = []; this.armActive = -1;
  this.sense = { light: false, sound: false, sonar: false, motion: false, display: true };
  this.levels = { light: 0x60, sound: 0x10 };
  this.irqFlags = 0; this.sleepSwitch = false;
  this.time = 0; this.cycles = 0; this.lastSonar = 0;
  this.speech = null; this.phrase = "";
  this.reset();
};

H.reset = function () {
  this.mode = "exec"; this.robot = false; this.block = null; this.keys = []; this.entry = null;
  this.ram[0x27] = this.ram[0x2A] = this.ram[0x2D] = 0x39;      // interrupt vectors reset to RTS
  this.cpu.sp = 0x0EDE; this.cpu.i = 1; this.cpu.waiting = false;
  for (var m = 0; m < 8; m++) this.tgt[m] = this.pos[m];
  this.armQueue = []; this.armActive = -1; this.speech = null;
  this.show("rEAdy ");
  this.emit("state");
};

/* ---------------- memory map ---------------- */
H.read = function (a) {
  if (a < 0x1000) return this.ram[a];
  if (a >= 0xC000 && a < 0xC400) return this.ioRead(a);
  return 0xFF;                       // unmapped, or ROM data we do not have
};
H.write = function (a, v) {
  if (a < 0x1000) { this.ram[a] = v; return; }
  if (a === 0xC200) { this.irqFlags &= ~v; return; }   // writing 1s clears interrupt flags
};
H.ioRead = function (a) {
  switch (a) {
    case 0xC200: return this.irqFlags;
    case 0xC240: return this.sense.sound ? this.levels.sound : this.sense.light ? this.levels.light : 0;
    case 0xC220: return this.ram[0x11];
  }
  return 0xFF;
};

/* ---------------- display ---------------- */
H.seg = [0,0,0,0,0,0]; H.dig = 0;
H.show = function (s) { this.seg = []; for (var i = 0; i < 6; i++) this.seg.push(TXT[s[i]] !== undefined ? TXT[s[i]] : HEXSEG[parseInt(s[i], 16)] || 0); this.dig = 0; this.emit("display"); };
H.showHex = function (prefix, val, n) { var s = prefix + hex(val, n); this.seg = []; for (var i = 0; i < 6; i++) { var c = s[i] || " "; this.seg.push(/[0-9A-F]/.test(c) ? HEXSEG[parseInt(c, 16)] : (TXT[c] || 0)); } this.emit("display"); };
H.outch = function (v) { if (this.dig < 6) this.seg[this.dig] = v; this.dig = (this.dig + 1) % 6; this.emit("display"); };

/* ---------------- keypad (executive and monitor, as described in the manual) ---------------- */
H.key = function (k) {   // k: 0..15, or "RESET"
  if (k === "RESET") { this.log("RESET"); this.reset(); return; }
  if (this.mode === "run") { this.keys.push(k); return; }
  var e = this.entry;
  if (e) {                               // collecting hex digits
    e.buf += hex(k, 1);
    if (e.kind === "addr") { this.showHex("", 0, 0); this.show((e.buf + "----").slice(0, 4) + "  "); if (e.buf.length === 4) { this.entry = null; e.done(parseInt(e.buf, 16)); } }
    else { this.showHex(hex(this.ea, 4), parseInt((e.buf + "0").slice(0, 2), 16), 2); if (e.buf.length === 2) { this.entry = null; e.done(parseInt(e.buf, 16)); } }
    return;
  }
  if (this.mode === "exec") {
    if (k === 1) { this.robot = false; this.mode = "mon"; this.show("6808  "); }
    else if (k === 0xA) { this.robot = true; this.mode = "mon"; this.show("robot "); }
    else if (k === 0xF || k === 0xC || k === 9) { this.run({ 0xF: 0x30, 0xC: 0x33, 9: 0x36 }[k], true); }
    else if (k === 3) { this.mode = "util"; this.show("Ut    "); }
    return;
  }
  if (this.mode === "util") {
    if (k === 1) { this.ram[0x0EC0] = 0x21; this.ram[0x0EC1] = 0x3A; this.run(0x0EC0, true); this.log("Utility 31: initialize (ZERO)"); }
    else if (k === 2) { this.armQueue = []; [1,2,3,4,5].forEach(function (m) { this.queueArm(m, MID[m], 2); }, this); this.mode = "exec"; this.show("rEAdy "); }
    return;
  }
  if (this.mode === "mon" || this.mode === "exam") {
    var self = this;
    if (this.mode === "exam") {
      if (k === 0xF) { this.ea = (this.ea + 1) & 0xFFFF; this.showEA(); return; }
      if (k === 0xB) { this.ea = (this.ea - 1) & 0xFFFF; this.showEA(); return; }
      if (k === 0xC) { this.entry = { kind: "data", buf: "", done: function (v) { self.write(self.ea, v); self.showEA(); self.emit("mem"); } }; this.showHex(hex(this.ea, 4), 0, 0); return; }
    }
    if (k === 0xA) { this.mode = "auto"; this.prompt(function (a) { self.ea = a; self.autoNext(); }); return; }
    if (k === 0xD) { this.prompt(function (a) { self.run(a, self.robot); }); return; }
    if (k === 0xE) { this.prompt(function (a) { self.ea = a; self.mode = "exam"; self.showEA(); }); return; }
    if (k >= 1 && k <= 4) { var c = this.cpu, v = [0, c.a, c.b, c.pc, c.x][k]; this.showHex(["", "A   ", "b   ", "PC", "-"][k].slice(0, k === 3 ? 2 : k === 4 ? 2 : 4), v, k >= 3 ? 4 : 2); return; }
  }
  if (this.mode === "auto") return;
};
H.prompt = function (done) { this.entry = { kind: "addr", buf: "", done: done }; this.show("Adr   "); };
H.showEA = function () { this.showHex(hex(this.ea, 4), this.read(this.ea), 2); this.emit("ea"); };
H.autoNext = function () {
  var self = this; this.showEA(); this.mode = "auto";
  this.entry = { kind: "data", buf: "", done: function (v) { self.write(self.ea, v); self.ea = (self.ea + 1) & 0xFFFF; self.emit("mem"); self.autoNext(); } };
};

/* ---------------- running ---------------- */
H.run = function (addr, robot) {
  this.cpu.pc = addr; this.cpu.sp = 0x0EDE; this.robot = !!robot; this.mode = "run"; this.block = null; this.keys = []; this.entry = null;
  this.cpu.push16(ROM.IRQRET - 2);   // a final RTS from the top level lands on "return to executive"
  this.show("      "); this.log((robot ? "Robot" : "Machine") + " Language run from $" + hex(addr, 4)); this.emit("state");
};
H.toExec = function (msg) { this.mode = "exec"; this.block = null; this.robot = false; if (msg) this.log(msg); this.show("rEAdy "); this.emit("state"); };
H.crash = function (msg) { this.mode = "halt"; this.block = null; this.log(msg); this.showHex("Er", this.cpu.pc, 4); this.emit("state"); };
H.abort = function () {   // Abort button on the experimental board: halt and show the program counter
  if (this.mode !== "run") return; this.mode = "halt"; this.armQueue = []; for (var m = 0; m < 8; m++) this.tgt[m] = this.pos[m]; this.speech = null;
  this.showHex("Pc", this.cpu.pc, 4); this.log("ABORT at $" + hex(this.cpu.pc, 4)); this.emit("state");
};

H.advance = function (dt) {             // dt seconds of real time
  dt = Math.min(dt, 0.1);
  this.motors(dt); this.sensors(dt); this.speechTick(dt);
  this.time += dt;
  if (this.mode !== "run") return;
  var budget = dt * CLOCK + (this.debt || 0), guard = 0;   // slow steps (ROM calls in Robot Language) carry over as debt
  while (budget > 0 && this.mode === "run" && guard++ < 200000) {
    if (this.pendingIRQ()) continue;
    if (this.block) { if (!this.unblocked()) break; this.block = null; }
    var cy = this.stepOne();
    budget -= cy; this.cycles += cy;
  }
  this.debt = budget < 0 ? budget : 0;
};

H.stepOne = function () {
  var c = this.cpu, pc = c.pc;
  if (pc >= 0xE000) return this.romCall(pc);
  var op = this.read(pc);
  if (!this.robot) {
    if (op === 0x3F) { c.pc = (pc + 1) & 0xFFFF; this.robot = true; return 12; }     // SWI: enter the interpreter
    return c.step();
  }
  if (ROBOT_OPS[op]) return this.robotOp(op, pc) + ROBOT_OVERHEAD;
  if (op === 0x3F) { c.pc = (pc + 1) & 0xFFFF; return ROBOT_OVERHEAD; }
  return c.step() + ROBOT_OVERHEAD;     // the interpreter also executes ordinary 6800 instructions, slowly
};

H.rts = function () { this.cpu.pc = this.cpu.pull16(); return 5; };
// ROM subroutines run natively in Machine Language; called from Robot Language the
// interpreter steps through them too, roughly 500x slower (manual: INCH 9 ms vs ~5 s).
H.romCall = function (pc) {
  var cy = this.romService(pc);
  return this.robot && pc !== ROM.IRQRET ? cy * 500 : cy;
};
H.romService = function (pc) {
  var c = this.cpu, i, n, v, a;
  switch (pc) {
    case ROM.INCH: if (!this.keys.length) { this.block = { key: true }; return 10; } c.a = this.keys.shift(); return this.rts() + 9000;
    case ROM.OUTCH: this.outch(c.a); return this.rts() + 60;
    case ROM.OUTHEX: this.outch(HEXSEG[c.a & 15]); return this.rts() + 80;
    case ROM.OUTBYT: this.outch(HEXSEG[c.a >> 4]); this.outch(HEXSEG[c.a & 15]); return this.rts() + 160;
    case ROM.CLRDIS: this.seg = [0,0,0,0,0,0]; this.dig = 0; this.emit("display"); return this.rts() + 120;
    case ROM.REDIS: this.dig = 0; return this.rts() + 20;
    case ROM.OUTSTR:                     // string follows the JSR; last character has its decimal point set
      a = c.pull16(); v = this.read(a++); this.outch(v);
      if (v & 0x80) c.pc = a; else c.push16(a);        // one character per call, so Robot Language shows them appear
      return 300;
    case ROM.DSPLAY: a = c.x; n = c.b; for (i = 0; i < n; i++) { v = this.read(a + i); this.outch(HEXSEG[v >> 4]); this.outch(HEXSEG[v & 15]); } return this.rts() + 200;
    case ROM.IRQRET: this.robot = this.irqRobot; this.block = this.irqBlock; c.setCC(c.pull()); c.b = c.pull(); c.a = c.pull(); c.x = c.pull16(); c.pc = c.pull16(); return 10;
    case ROM.IRQRET - 2: this.toExec("Program returned to the executive."); return 5;
  }
  this.crash("JSR to ROM $" + hex(pc, 4) + ": that routine is not modeled (the ROM image is not available)."); return 0;
};

/* ---------------- interrupts: three RAM vectors, dispatched by the ROM ---------------- */
H.raise = function (bit) { this.irqFlags |= bit; };
H.pendingIRQ = function () {
  var c = this.cpu, f = this.irqFlags, vec = 0;
  if (c.i || !f) return false;
  if (f & 0x02) vec = 0x27; else if (f & 0x20) vec = 0x2A; else if (f & 0x80) vec = 0x2D; else return false;
  this.irqFlags &= ~(f & 0xA2);
  c.waiting = false;
  c.push16(c.pc); c.push16(c.x); c.push(c.a); c.push(c.b); c.push(c.getCC()); c.i = 1;
  this.irqRobot = this.robot; this.robot = false;          // the handler runs as machine language
  this.irqBlock = this.block; this.block = null;           // a pause or speak-wait resumes after the handler
  c.push16(ROM.IRQRET); c.pc = vec;
  return true;
};

/* ---------------- Robot Interpreter ---------------- */
H.mword = function (w) { return { m: w >> 13, s: (w >> 11) & 3, d: (w >> 10) & 1, p: w & 0x3FF }; };
H.robotOp = function (op, pc) {
  var c = this.cpu, len = ROBOT_OPS[op], b1 = this.read(pc + 1), b2 = this.read(pc + 2), w, a, rel, k;
  c.pc = (pc + len) & 0xFFFF;
  switch (op) {
    case 0x02: this.tgt[0] = this.pos[0]; break;
    case 0x03: this.tgt[7] = this.pos[7]; break;
    case 0x04: this.armQueue = []; for (k = 1; k <= 6; k++) this.tgt[k] = this.pos[k]; this.armActive = -1; break;
    case 0x05: this.speech = null; this.emit("speech", ""); break;
    case 0x1C: case 0x1D: case 0x1E: case 0x1F:
      if ([this.busy(0), this.busy(7), this.armBusy(), !!this.speech][op - 0x1C]) c.pc = (c.pc + (b1 < 128 ? b1 : b1 - 256)) & 0xFFFF; break;
    case 0x21: this.armQueue = []; for (k = 1; k <= 6; k++) this.queueArm(k, MID[k], 3); this.setMove(7, MID[7], 3); this.block = { all: true }; break;
    case 0x3A: this.toExec("3A: return to executive."); return 0;
    case 0x41: this.sense.light = true; break; case 0x51: this.sense.light = false; break;
    case 0x42: this.sense.sound = true; break; case 0x52: this.sense.sound = false; break;
    case 0x45: this.sense.sonar = true; break; case 0x5B: this.sense.sonar = false; break;
    case 0x4B: this.sense.motion = true; break; case 0x55: this.sense.motion = false; break;
    case 0x4E: this.sense.display = true; break; case 0x5E: this.sense.display = false; break;
    case 0x61: case 0x62: this.speak((c.x + b1) & 0xFFFF, op === 0x62); break;
    case 0x71: case 0x72: this.speak((b1 << 8) | b2, op === 0x72); break;
    case 0x83: this.robot = false; break;
    case 0x87: if (this.sleepSwitch) this.block = { until: this.time + ((b1 << 8) | b2) * 10 }; else this.log("87 sleep skipped: the Sleep/Normal switch is at Normal."); break;
    case 0x8F: this.block = { until: this.time + ((b1 << 8) | b2) / 16 }; break;
    case 0xC3: case 0xCC: case 0xD3: case 0xDC: case 0xE3: case 0xEC: case 0xF3: case 0xFC:
      if (op === 0xE3 || op === 0xEC) { a = (c.x + b1) & 0xFFFF; w = (this.read(a) << 8) | this.read(a + 1); }
      else if (op === 0xF3 || op === 0xFC) { a = (b1 << 8) | b2; w = (this.read(a) << 8) | this.read(a + 1); }
      else w = (b1 << 8) | b2;
      rel = (op & 0xF0) === 0xD0;
      var mw = this.mword(w);
      this.motorCmd(mw, rel);
      if ((op & 0x0F) === 3) this.block = { motor: mw.m };
      break;
    case 0xFD:
      for (k = 0; k < 6; k++) this.queueArm(k + 1, this.read(pc + 1 + k), 2);
      this.setMove(7, this.read(pc + 7), 2); this.block = { all: true }; break;
  }
  return 0;
};
H.motorCmd = function (k, rel) {
  var m = k.m;
  if (m === 0) {                       // drive: position zeroed, D gives direction (manual errata)
    this.pos[0] = 0; this.tgt[0] = k.d ? -k.p : k.p; this.spd[0] = SPEED.drive[k.s]; return;
  }
  var t = rel ? this.posAfterQueue(m) + (k.d ? -k.p : k.p) : k.p;
  t = Math.max(0, Math.min(MAXP[m], t));
  if (m === 7) this.setMove(7, t, k.s); else this.queueArm(m, t, k.s);
};
H.posAfterQueue = function (m) { var p = this.tgt[m]; this.armQueue.forEach(function (q) { if (q.m === m) p = q.t; }); return p; };
H.setMove = function (m, t, s) { this.tgt[m] = Math.max(0, Math.min(MAXP[m], t)); this.spd[m] = (m === 0 ? SPEED.drive : SPEED.arm)[s]; };
H.queueArm = function (m, t, s) { this.armQueue.push({ m: m, t: Math.max(0, Math.min(MAXP[m], t)), s: s }); };
H.busy = function (m) {
  if (m >= 1 && m <= 6) { if (this.armActive === m) return true; for (var i = 0; i < this.armQueue.length; i++) if (this.armQueue[i].m === m) return true; }
  return Math.abs(this.pos[m] - this.tgt[m]) > 1e-6;
};
H.armBusy = function () { return this.armActive >= 0 || this.armQueue.length > 0; };
H.unblocked = function () {
  var b = this.block;
  if (b.key) return this.keys.length > 0;
  if (b.motor !== undefined) return !this.busy(b.motor);
  if (b.all) return !this.armBusy() && !this.busy(7);
  if (b.until !== undefined) return this.time >= b.until;
  if (b.speech) return !this.speech;
  return true;
};

/* ---------------- speech: phoneme strings end at FF; BF aaaa jumps (max 8 deep) ---------------- */
H.speak = function (addr, wait) {
  var list = [], stack = [], a = addr, guard = 0;
  while (guard++ < 512) {
    var v = this.read(a);
    if (v === 0xFF) { if (!stack.length) break; a = stack.pop(); continue; }
    if (v === 0xBF) { if (stack.length >= 8) { this.crash("Speech crashed: more than eight BF jumps without an FF."); return; } stack.push(a + 3); a = (this.read(a + 1) << 8) | this.read(a + 2); continue; }
    list.push(v); a++;
  }
  var names = list.map(function (v) { return PH[v & 0x3F] + (v >> 6 ? "'" .repeat(v >> 6) : ""); });
  var ms = list.reduce(function (s, v) { return s + PDUR[v & 0x3F]; }, 0);
  this.speech = { until: this.time + ms / 1000, list: list };
  this.emit("speech", names.join(" "));
  if (wait) this.block = { speech: true };
};
H.speechTick = function () { if (this.speech && this.time >= this.speech.until) { this.speech = null; this.emit("speech", ""); } };

/* ---------------- motors and kinematics ---------------- */
H.motors = function (dt) {
  if (this.armActive >= 0 && !(Math.abs(this.pos[this.armActive] - this.tgt[this.armActive]) > 1e-6)) this.armActive = -1;
  if (this.armActive < 0 && this.armQueue.length) { var q = this.armQueue.shift(); this.armActive = q.m; this.tgt[q.m] = q.t; this.spd[q.m] = SPEED.arm[q.s]; }
  for (var m = 0; m < 8; m++) {
    var d = this.tgt[m] - this.pos[m]; if (!d) continue;
    var st = Math.sign(d) * Math.min(Math.abs(d), this.spd[m] * dt);
    if (m === 0) this.drive(st);
    this.pos[m] += st;
    if (Math.abs(this.tgt[m] - this.pos[m]) < 1e-6) this.pos[m] = this.tgt[m];
  }
  for (m = 1; m < 8; m++) this.ram[m - 1] = Math.round(this.pos[m]);
};
H.steerAngle = function () { return (this.pos[7] - 0x49) / 0x49 * 1.3; };      // radians, + = right
H.headAngle = function () { return (this.pos[6] - 0x61) / 0x61 * (175 * Math.PI / 180); };
H.drive = function (units) {
  var W = this.world, ds = units * DRIVE_IN * (40 / 12);  // world: 40 px per foot
  var phi = this.steerAngle(), L = 30;
  var nx = W.x + ds * Math.cos(phi) * Math.sin(W.th), ny = W.y - ds * Math.cos(phi) * Math.cos(W.th);
  if (this.hitsWall(nx, ny, 28)) { this.tgt[0] = this.pos[0]; this.log("Bump: the robot ran into something and the drive stopped."); return; }
  W.th += ds * Math.sin(phi) / L; W.x = nx; W.y = ny;
  var t = W.trail, last = t[t.length - 1];
  if (!last || Math.hypot(last[0] - W.x, last[1] - W.y) > 3) { t.push([W.x, W.y]); if (t.length > 800) t.shift(); }
};
H.hitsWall = function (x, y, r) {
  return this.world.walls.some(function (w) {
    var dx = w[2] - w[0], dy = w[3] - w[1], l2 = dx * dx + dy * dy, t = Math.max(0, Math.min(1, ((x - w[0]) * dx + (y - w[1]) * dy) / l2));
    return Math.hypot(x - (w[0] + t * dx), y - (w[1] + t * dy)) < r;
  });
};
H.sonarDistance = function () {                     // inches from the head along its facing, or Infinity
  var W = this.world, ang = W.th + this.headAngle(), ox = W.x, oy = W.y, dx = Math.sin(ang), dy = -Math.cos(ang), best = Infinity;
  W.walls.forEach(function (w) {
    var ex = w[2] - w[0], ey = w[3] - w[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) return;
    var t = ((w[0] - ox) * ey - (w[1] - oy) * ex) / den, u = ((w[0] - ox) * dy - (w[1] - oy) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  });
  return best / 40 * 12;
};
H.sensors = function () {
  if (this.sense.sonar && this.time - this.lastSonar >= 0.05) {
    this.lastSonar = this.time;
    var d = this.sonarDistance();
    if (d >= 4 && d <= 96) { this.ram[0x11] = Math.min(255, Math.round(d / 0.4)); this.ram[0x10] = (this.ram[0x10] + 1) & 0xFF; }
  }
  if (this.levels.soundUntil && this.time > this.levels.soundUntil) { this.levels.sound = 0x10; this.levels.soundUntil = 0; }
};
H.clap = function () { this.levels.sound = 0xC0; this.levels.soundUntil = this.time + 0.25; };
H.trigger = function () { this.raise(0x20); };
H.motion = function () { if (this.sense.motion) this.raise(0x02); };

/* ---------------- disassembler (6800 + Robot Language) ---------------- */
var MN = {};
(function () {
  var inh = {0x01:"NOP",0x06:"TAP",0x07:"TPA",0x08:"INX",0x09:"DEX",0x0A:"CLV",0x0B:"SEV",0x0C:"CLC",0x0D:"SEC",0x0E:"CLI",0x0F:"SEI",0x10:"SBA",0x11:"CBA",0x16:"TAB",0x17:"TBA",0x19:"DAA",0x1B:"ABA",
    0x30:"TSX",0x31:"INS",0x32:"PULA",0x33:"PULB",0x34:"DES",0x35:"TXS",0x36:"PSHA",0x37:"PSHB",0x39:"RTS",0x3B:"RTI",0x3E:"WAI",0x3F:"SWI"};
  for (var k in inh) MN[k] = [inh[k], 1, ""];
  var br = ["BRA",null,"BHI","BLS","BCC","BCS","BNE","BEQ","BVC","BVS","BPL","BMI","BGE","BLT","BGT","BLE"];
  br.forEach(function (n, i) { if (n) MN[0x20 + i] = [n, 2, "rel"]; });
  var rmw = {0:"NEG",3:"COM",4:"LSR",6:"ROR",7:"ASR",8:"ASL",9:"ROL",0xA:"DEC",0xC:"INC",0xD:"TST",0xF:"CLR"};
  for (k in rmw) { MN[0x40 + +k] = [rmw[k] + "A", 1, ""]; MN[0x50 + +k] = [rmw[k] + "B", 1, ""]; MN[0x60 + +k] = [rmw[k], 2, "idx"]; MN[0x70 + +k] = [rmw[k], 3, "ext"]; }
  MN[0x6E] = ["JMP", 2, "idx"]; MN[0x7E] = ["JMP", 3, "ext"];
  var alu = {0:"SUB",1:"CMP",2:"SBC",4:"AND",5:"BIT",6:"LDA",7:"STA",8:"EOR",9:"ADC",0xA:"ORA",0xB:"ADD"};
  var modes = [["imm",2],["dir",2],["idx",2],["ext",3]];
  for (var hi = 0; hi < 8; hi++) {
    var acc = hi < 4 ? "A" : "B", md = modes[hi & 3];
    for (k in alu) { if (+k === 7 && (hi & 3) === 0) continue; MN[0x80 + hi * 16 + +k] = [alu[k] + acc, md[1], md[0]]; }
  }
  [[0x8C,"CPX"],[0x8E,"LDS"],[0x8F,"STS"],[0xCE,"LDX"],[0xCF,"STX"]].forEach(function (p) {
    for (var j = 0; j < 4; j++) { var o = p[0] + j * 16; if ((p[1] === "STS" || p[1] === "STX") && j === 0) continue; MN[o] = [p[1], j === 0 ? 3 : j === 3 ? 3 : 2, ["imm16","dir","idx","ext"][j]]; }
  });
  MN[0x8D] = ["BSR", 2, "rel"]; MN[0xAD] = ["JSR", 2, "idx"]; MN[0xBD] = ["JSR", 3, "ext"];
})();
var RNAME = {0x02:"ABORT drive",0x03:"ABORT steering",0x04:"ABORT arm",0x05:"ABORT speech",0x21:"ZERO",0x3A:"RETURN to executive",0x41:"ENABLE light",0x42:"ENABLE sound",0x45:"ENABLE sonar",0x4B:"ENABLE motion",0x4E:"ENABLE display",0x51:"DISABLE light",0x52:"DISABLE sound",0x55:"DISABLE motion",0x5B:"DISABLE sonar",0x5E:"DISABLE display",0x83:"MACHINE LANGUAGE"};
var ROMNAME = {}; for (var rk in ROM) ROMNAME[ROM[rk]] = rk;
H.disasm = function (a, robot) {
  var op = this.read(a), b1 = this.read(a + 1), b2 = this.read(a + 2), w16 = (b1 << 8) | b2;
  var rel = function (o) { return hex((a + 2 + (o < 128 ? o : o - 256)) & 0xFFFF, 4); };
  if (robot && ROBOT_OPS[op]) {
    var len = ROBOT_OPS[op], t;
    if (RNAME[op]) t = RNAME[op];
    else if (op >= 0x1C && op <= 0x1F) t = "BRANCH if " + ["drive", "steering", "arm", "speech"][op - 0x1C] + " busy $" + rel(b1);
    else if (op === 0x61 || op === 0x62) t = "SPEAK " + hex(b1, 2) + ",X" + (op === 0x62 ? " wait" : "");
    else if (op === 0x71 || op === 0x72) t = "SPEAK $" + hex(w16, 4) + (op === 0x72 ? " wait" : "");
    else if (op === 0x87) t = "SLEEP " + (w16 * 10) + " s";
    else if (op === 0x8F) t = "PAUSE " + (w16 / 16) + " s";
    else if (op === 0xFD) { t = "MOVE ALL"; for (var i = 1; i < 8; i++) t += " " + hex(this.read(a + i), 2); }
    else if (op === 0xE3 || op === 0xEC) t = "MOVE abs " + hex(b1, 2) + ",X" + (op === 0xE3 ? " wait" : "");
    else if (op === 0xF3 || op === 0xFC) t = "MOVE abs ($" + hex(w16, 4) + ")" + (op === 0xF3 ? " wait" : "");
    else { var k = this.mword(w16), r = (op & 0xF0) === 0xD0; t = "MOVE " + MOT[k.m] + (r ? " rel " + (k.d ? "-" : "+") : (k.m === 0 ? (k.d ? " rev " : " fwd ") : " to ")) + "$" + hex(k.p, 3) + " " + ["slow", "slow", "med", "fast"][k.s] + ((op & 0x0F) === 3 ? ", wait" : ""); }
    return { len: len, text: t, robot: true };
  }
  var m = MN[op];
  if (!m) return { len: 1, text: "FCB $" + hex(op, 2), bad: true };
  var arg = "";
  switch (m[2]) {
    case "imm": arg = "#$" + hex(b1, 2); break;
    case "imm16": arg = "#$" + hex(w16, 4); break;
    case "dir": arg = "$" + hex(b1, 2); break;
    case "idx": arg = "$" + hex(b1, 2) + ",X"; break;
    case "ext": arg = "$" + hex(w16, 4) + (ROMNAME[w16] ? "  " + ROMNAME[w16] : ""); break;
    case "rel": arg = "$" + rel(b1); break;
  }
  var text = m[0] + (arg ? " " + arg : "");
  if (op === 0x3F && !robot) text = "SWI  → Robot Language";
  return { len: m[1], text: text };
};

root.Hero = Hero;
if (typeof module !== "undefined") module.exports = Hero;
})(typeof window !== "undefined" ? window : globalThis);
