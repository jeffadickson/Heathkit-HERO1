/* MC6800 / MC6808 CPU core.
 * bus = { read(addr) -> byte, write(addr, byte) }
 * step() executes one instruction and returns its cycle count.
 * Undefined opcodes call onIllegal(op, pc) (default: throw); the HERO machine
 * uses that hook for Robot Interpreter opcodes. */
function M6800(bus) {
  this.bus = bus;
  this.a = 0; this.b = 0; this.x = 0; this.sp = 0; this.pc = 0;
  this.h = 0; this.i = 1; this.n = 0; this.z = 0; this.v = 0; this.c = 0;
  this.waiting = false;
  this.onIllegal = function (op, pc) { throw new Error("illegal opcode " + op.toString(16) + " at " + pc.toString(16)); };
}
(function (P) {
  // cycle counts, 0 = undefined opcode
  var CY = [
  //0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F
    0, 2, 0, 0, 0, 0, 2, 2, 4, 4, 2, 2, 2, 2, 2, 2, // 0
    2, 2, 0, 0, 0, 0, 2, 2, 0, 2, 0, 2, 0, 0, 0, 0, // 1
    4, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, // 2
    4, 4, 4, 4, 4, 4, 4, 4, 0, 5, 0,10, 0, 0, 9,12, // 3
    2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2, // 4
    2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2, // 5
    7, 0, 0, 7, 7, 0, 7, 7, 7, 7, 7, 0, 7, 7, 4, 7, // 6
    6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6, // 7
    2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 2, 3, 8, 3, 0, // 8
    3, 3, 3, 0, 3, 3, 3, 4, 3, 3, 3, 3, 4, 0, 4, 5, // 9
    5, 5, 5, 0, 5, 5, 5, 6, 5, 5, 5, 5, 6, 8, 6, 7, // A
    4, 4, 4, 0, 4, 4, 4, 5, 4, 4, 4, 4, 5, 9, 5, 6, // B
    2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 2, 0, 0, 3, 0, // C
    3, 3, 3, 0, 3, 3, 3, 4, 3, 3, 3, 3, 0, 0, 4, 5, // D
    5, 5, 5, 0, 5, 5, 5, 6, 5, 5, 5, 5, 0, 0, 6, 7, // E
    4, 4, 4, 0, 4, 4, 4, 5, 4, 4, 4, 4, 0, 0, 5, 6  // F
  ];
  P.CYCLES = CY;
  P.isDefined = function (op) { return CY[op] !== 0; };

  P.rd = function (a) { return this.bus.read(a & 0xFFFF) & 0xFF; };
  P.wr = function (a, v) { this.bus.write(a & 0xFFFF, v & 0xFF); };
  P.rd16 = function (a) { return (this.rd(a) << 8) | this.rd(a + 1); };
  P.fetch = function () { var v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; };
  P.fetch16 = function () { var v = this.rd16(this.pc); this.pc = (this.pc + 2) & 0xFFFF; return v; };
  P.push = function (v) { this.wr(this.sp, v); this.sp = (this.sp - 1) & 0xFFFF; };
  P.pull = function () { this.sp = (this.sp + 1) & 0xFFFF; return this.rd(this.sp); };
  P.push16 = function (v) { this.push(v & 0xFF); this.push(v >> 8); };
  P.pull16 = function () { var hi = this.pull(); return (hi << 8) | this.pull(); };

  P.getCC = function () {
    return 0xC0 | (this.h << 5) | (this.i << 4) | (this.n << 3) | (this.z << 2) | (this.v << 1) | this.c;
  };
  P.setCC = function (f) {
    this.h = (f >> 5) & 1; this.i = (f >> 4) & 1; this.n = (f >> 3) & 1;
    this.z = (f >> 2) & 1; this.v = (f >> 1) & 1; this.c = f & 1;
  };
  P.nz = function (r) { this.n = (r >> 7) & 1; this.z = (r & 0xFF) === 0 ? 1 : 0; };
  P.nz16 = function (r) { this.n = (r >> 15) & 1; this.z = (r & 0xFFFF) === 0 ? 1 : 0; };

  P.add = function (a, b, cin) {
    var r = a + b + cin;
    this.h = ((a ^ b ^ r) >> 4) & 1;
    this.v = (((a ^ r) & (b ^ r)) >> 7) & 1;
    this.c = (r >> 8) & 1; r &= 0xFF; this.nz(r); return r;
  };
  P.sub = function (a, b, cin) {
    var r = a - b - cin;
    this.v = (((a ^ b) & (a ^ r)) >> 7) & 1;
    this.c = r < 0 ? 1 : 0; r &= 0xFF; this.nz(r); return r;
  };
  P.logic = function (r) { this.nz(r); this.v = 0; return r; };

  // read-modify-write group (NEG..CLR); op low nibble selects function
  P.rmw = function (lo, m) {
    var r;
    switch (lo) {
      case 0x0: r = (-m) & 0xFF; this.c = r !== 0 ? 1 : 0; this.v = r === 0x80 ? 1 : 0; this.nz(r); return r;      // NEG
      case 0x3: r = (~m) & 0xFF; this.c = 1; this.v = 0; this.nz(r); return r;                                    // COM
      case 0x4: this.c = m & 1; r = m >> 1; this.nz(r); this.v = this.n ^ this.c; return r;                       // LSR
      case 0x6: r = (this.c << 7) | (m >> 1); this.c = m & 1; this.nz(r); this.v = this.n ^ this.c; return r;    // ROR
      case 0x7: this.c = m & 1; r = (m & 0x80) | (m >> 1); this.nz(r); this.v = this.n ^ this.c; return r;       // ASR
      case 0x8: this.c = (m >> 7) & 1; r = (m << 1) & 0xFF; this.nz(r); this.v = this.n ^ this.c; return r;      // ASL
      case 0x9: r = ((m << 1) | this.c) & 0xFF; this.c = (m >> 7) & 1; this.nz(r); this.v = this.n ^ this.c; return r; // ROL
      case 0xA: r = (m - 1) & 0xFF; this.v = m === 0x80 ? 1 : 0; this.nz(r); return r;                           // DEC
      case 0xC: r = (m + 1) & 0xFF; this.v = m === 0x7F ? 1 : 0; this.nz(r); return r;                           // INC
      case 0xD: this.nz(m); this.v = 0; this.c = 0; return -1;                                                   // TST (no write)
      case 0xF: this.n = 0; this.z = 1; this.v = 0; this.c = 0; return 0;                                         // CLR
    }
    return -2;
  };

  P.branch = function (op) {
    var c;
    switch (op) {
      case 0x20: c = true; break;
      case 0x22: c = (this.c | this.z) === 0; break;
      case 0x23: c = (this.c | this.z) === 1; break;
      case 0x24: c = this.c === 0; break;
      case 0x25: c = this.c === 1; break;
      case 0x26: c = this.z === 0; break;
      case 0x27: c = this.z === 1; break;
      case 0x28: c = this.v === 0; break;
      case 0x29: c = this.v === 1; break;
      case 0x2A: c = this.n === 0; break;
      case 0x2B: c = this.n === 1; break;
      case 0x2C: c = (this.n ^ this.v) === 0; break;
      case 0x2D: c = (this.n ^ this.v) === 1; break;
      case 0x2E: c = (this.z | (this.n ^ this.v)) === 0; break;
      case 0x2F: c = (this.z | (this.n ^ this.v)) === 1; break;
    }
    return c;
  };

  P.interrupt = function (vector) {
    if (!this.waiting) { this.push16(this.pc); this.push16(this.x); this.push(this.a); this.push(this.b); this.push(this.getCC()); }
    this.waiting = false; this.i = 1; this.pc = this.rd16(vector);
  };
  P.irq = function () { if (this.i) return false; this.interrupt(0xFFF8); return true; };
  P.nmi = function () { this.interrupt(0xFFFC); };
  P.reset = function () { this.i = 1; this.waiting = false; this.pc = this.rd16(0xFFFE); };

  P.step = function () {
    if (this.waiting) return 1;
    var pc0 = this.pc, op = this.fetch(), cy = CY[op], ea, m, r, t, hi = op >> 4, lo = op & 0xF;
    if (cy === 0) { this.pc = pc0; return this.onIllegal(op, pc0) || 0; }

    if (hi >= 8) {
      // accumulator/memory group
      var acc = hi >= 0xC ? "b" : "a", mode = hi & 3;
      // 16-bit ops: CPX(8C..BC) LDS(8E..BE) STS(9F..BF) LDX(CE..FE) STX(DF..FF) BSR(8D) JSR(AD BD)
      if (lo >= 0xC) {
        if (op === 0x8D) { t = this.fetch(); this.push16(this.pc); this.pc = (this.pc + (t < 128 ? t : t - 256)) & 0xFFFF; return cy; }
        if (op === 0xAD || op === 0xBD) { ea = op === 0xAD ? (this.x + this.fetch()) & 0xFFFF : this.fetch16(); this.push16(this.pc); this.pc = ea; return cy; }
        ea = mode === 0 ? (this.pc = (this.pc + 2) & 0xFFFF, (this.pc - 2) & 0xFFFF)
           : mode === 1 ? this.fetch() : mode === 2 ? (this.x + this.fetch()) & 0xFFFF : this.fetch16();
        if (lo === 0xC) { // CPX
          m = this.rd16(ea); r = this.x - m;
          var xh = this.x >> 8, mh = m >> 8, rh = (xh - mh) & 0xFF;
          this.n = (rh >> 7) & 1; this.z = (r & 0xFFFF) === 0 ? 1 : 0;
          this.v = (((xh ^ mh) & (xh ^ rh)) >> 7) & 1;
          return cy;
        }
        if (lo === 0xE) { r = this.rd16(ea); if (hi < 0xC) this.sp = r; else this.x = r; this.nz16(r); this.v = 0; return cy; }
        if (lo === 0xF) { r = hi < 0xC ? this.sp : this.x; this.wr(ea, r >> 8); this.wr(ea + 1, r); this.nz16(r); this.v = 0; return cy; }
      }
      if (lo === 7) { // STA
        ea = mode === 1 ? this.fetch() : mode === 2 ? (this.x + this.fetch()) & 0xFFFF : this.fetch16();
        this.wr(ea, this[acc]); this.logic(this[acc]); return cy;
      }
      m = mode === 0 ? this.fetch() : this.rd(mode === 1 ? this.fetch() : mode === 2 ? (this.x + this.fetch()) & 0xFFFF : this.fetch16());
      t = this[acc];
      switch (lo) {
        case 0x0: this[acc] = this.sub(t, m, 0); break;          // SUB
        case 0x1: this.sub(t, m, 0); break;                      // CMP
        case 0x2: this[acc] = this.sub(t, m, this.c); break;     // SBC
        case 0x4: this[acc] = this.logic(t & m); break;          // AND
        case 0x5: this.logic(t & m); break;                      // BIT
        case 0x6: this[acc] = this.logic(m); break;              // LDA
        case 0x8: this[acc] = this.logic(t ^ m); break;          // EOR
        case 0x9: this[acc] = this.add(t, m, this.c); break;     // ADC
        case 0xA: this[acc] = this.logic(t | m); break;          // ORA
        case 0xB: this[acc] = this.add(t, m, 0); break;          // ADD
      }
      return cy;
    }
    if (hi === 4 || hi === 5) {
      var k = hi === 4 ? "a" : "b"; r = this.rmw(lo, this[k]); if (r >= 0) this[k] = r; return cy;
    }
    if (hi === 6 || hi === 7) {
      ea = hi === 6 ? (this.x + this.fetch()) & 0xFFFF : this.fetch16();
      if (lo === 0xE) { this.pc = ea; return cy; }   // JMP
      if (lo === 0xF) { this.rmw(lo, 0); this.wr(ea, 0); return cy; }
      r = this.rmw(lo, this.rd(ea)); if (r >= 0) this.wr(ea, r); return cy;
    }
    if (hi === 2) { t = this.fetch(); if (this.branch(op)) this.pc = (this.pc + (t < 128 ? t : t - 256)) & 0xFFFF; return cy; }
    switch (op) {
      case 0x01: break;
      case 0x06: this.setCC(this.a); break;                       // TAP
      case 0x07: this.a = this.getCC(); break;                    // TPA
      case 0x08: this.x = (this.x + 1) & 0xFFFF; this.z = this.x === 0 ? 1 : 0; break;
      case 0x09: this.x = (this.x - 1) & 0xFFFF; this.z = this.x === 0 ? 1 : 0; break;
      case 0x0A: this.v = 0; break; case 0x0B: this.v = 1; break;
      case 0x0C: this.c = 0; break; case 0x0D: this.c = 1; break;
      case 0x0E: this.i = 0; break; case 0x0F: this.i = 1; break;
      case 0x10: this.a = this.sub(this.a, this.b, 0); break;     // SBA
      case 0x11: this.sub(this.a, this.b, 0); break;              // CBA
      case 0x16: this.b = this.logic(this.a); break;              // TAB
      case 0x17: this.a = this.logic(this.b); break;              // TBA
      case 0x19: {                                                // DAA
        var a = this.a, cf = 0, l = a & 0xF, u = a >> 4;
        if (this.h || l > 9) cf |= 0x06;
        if (this.c || u > 9 || (u > 8 && l > 9)) cf |= 0x60;
        r = a + cf; if (cf & 0x60) this.c = 1;
        this.v = (((a ^ r) & (cf ^ r)) >> 7) & 1;
        this.a = r & 0xFF; this.nz(this.a); break; }
      case 0x1B: this.a = this.add(this.a, this.b, 0); break;     // ABA
      case 0x30: this.x = (this.sp + 1) & 0xFFFF; break;          // TSX
      case 0x31: this.sp = (this.sp + 1) & 0xFFFF; break;         // INS
      case 0x32: this.a = this.pull(); break;
      case 0x33: this.b = this.pull(); break;
      case 0x34: this.sp = (this.sp - 1) & 0xFFFF; break;         // DES
      case 0x35: this.sp = (this.x - 1) & 0xFFFF; break;          // TXS
      case 0x36: this.push(this.a); break;
      case 0x37: this.push(this.b); break;
      case 0x39: this.pc = this.pull16(); break;                  // RTS
      case 0x3B: this.setCC(this.pull()); this.b = this.pull(); this.a = this.pull(); this.x = this.pull16(); this.pc = this.pull16(); break;
      case 0x3E: this.push16(this.pc); this.push16(this.x); this.push(this.a); this.push(this.b); this.push(this.getCC()); this.waiting = true; break;
      case 0x3F: this.push16(this.pc); this.push16(this.x); this.push(this.a); this.push(this.b); this.push(this.getCC()); this.i = 1; this.pc = this.rd16(0xFFFA); break;
    }
    return cy;
  };
})(M6800.prototype);
if (typeof module !== "undefined") module.exports = M6800;
