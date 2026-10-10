"""Code/data map for the HERO 1 ROM.

Static trace seeded by emulator coverage (build-coverage.json), the vectors, the
Robot Interpreter dispatch table and the executive key table. Classifies every
byte as one of:
  code   native 6800 instruction
  robot  Robot Language instruction (the ROM's own interpreted code, after SWI)
  str    display string inline after JSR OUTSTR (segment codes, bit 7 ends)
  phon   SC-01 phoneme string (FF ends; BF aaaa jumps)
  data   anything else (tables), refined by hand in annotations
Writes build/map.json.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from m6800 import OPS, LEN

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rom = open(os.path.join(ROOT, 'HERO.ROM'), 'rb').read()
BASE = 0xE000
rd = lambda a: rom[a - BASE]
rd16 = lambda a: (rd(a) << 8) | rd(a + 1)

ROBOT_LEN = {0x02: 1, 0x03: 1, 0x04: 1, 0x05: 1, 0x1C: 2, 0x1D: 2, 0x1E: 2, 0x1F: 2, 0x21: 1, 0x3A: 1,
             0x41: 1, 0x42: 1, 0x45: 1, 0x4B: 1, 0x4E: 1, 0x51: 1, 0x52: 1, 0x55: 1, 0x5B: 1, 0x5E: 1,
             0x61: 2, 0x62: 2, 0x71: 3, 0x72: 3, 0x83: 1, 0x87: 3, 0x8F: 3, 0xC3: 3, 0xCC: 3, 0xD3: 3,
             0xDC: 3, 0xE3: 2, 0xEC: 2, 0xF3: 3, 0xFC: 3, 0xFD: 8}
# Entry points whose caller's return address is the start of an inline segment string:
# OUTSTR itself, and stubs that load a display position into X and JMP to $F7E2.
OUTSTR_ENTRIES = {0xF7E5}
for _o in range(len(rom) - 5):
    if rom[_o] == 0xCE and rom[_o + 3:_o + 6] == bytes([0x7E, 0xF7, 0xE2]):
        OUTSTR_ENTRIES.add(BASE + _o)
OUTSTR_ENTRIES.add(0xF70A)         # CLRB, then falls into the $F70B stub
DISPATCH = 0xE03C                  # robot opcode table: (op, handler) triples, 00 ends
KEYTAB = (0xE51F, 16)              # executive key table: 16 handler words

kind = {}                          # addr -> (kind, length)
notes = []

def claim(a, k, n):
    for i in range(n):
        if a + i in kind and kind[a + i][0] != k:
            notes.append('conflict at %04X: %s vs %s' % (a + i, kind[a + i][0], k))
    for i in range(n):
        kind[a + i] = (k, n if i == 0 else 0)

def mark_str(a):
    s = a
    while BASE <= a <= 0xFFFF:
        v = rd(a); a += 1
        if v & 0x80: break
    claim(s, 'str', a - s)
    return a

def mark_phon(a, depth=0):
    if not (BASE <= a <= 0xFFFF) or (a in kind and kind[a][0] == 'phon') or depth > 8: return
    s = a
    while BASE <= a <= 0xFFFF:
        v = rd(a)
        if v == 0xFF: a += 1; break
        if v == 0xBF: mark_phon(rd16(a + 1), depth + 1); a += 3; continue
        a += 1
    claim(s, 'phon', a - s)

work = []          # (addr, mode)

def trace():
    while work:
        a, mode = work.pop()
        while BASE <= a <= 0xFFFF and a not in kind:
            op = rd(a)
            if mode == 'robot' and op in ROBOT_LEN:
                n = ROBOT_LEN[op]; claim(a, 'robot', n)
                if op in (0x1C, 0x1D, 0x1E, 0x1F):
                    o = rd(a + 1); work.append(((a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF, 'robot'))
                if op in (0x71, 0x72): mark_phon(rd16(a + 1))
                a += n
                if op == 0x3A: break
                if op == 0x83: mode = 'native'
                continue
            if op not in OPS:
                notes.append('undefined opcode %02X at %04X (%s)' % (op, a, mode)); break
            mn, md = OPS[op]; n = LEN[md]
            claim(a, 'code' if mode == 'native' else 'robot', n)
            if md == 'rel':
                o = rd(a + 1); t = (a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF
                if mn == 'BSR' and t in OUTSTR_ENTRIES:
                    a = mark_str(a + 2); continue
                work.append((t, mode))
            if mn in ('JSR', 'JMP') and md == 'ext':
                t = rd16(a + 1)
                if t in OUTSTR_ENTRIES and mn == 'JSR':
                    a = mark_str(a + 3); continue
                work.append((t, 'native'))
            a += n
            if mn == 'SWI' and mode == 'native':
                mode = 'robot'; continue
            if mn in ('BRA', 'RTS', 'RTI', 'JMP', 'WAI'): break

cov = json.load(open(os.path.join(ROOT, 'build-coverage.json')))
for a, _ in cov:
    if a >= BASE: work.append((a, 'native'))
for v in (0xFFF8, 0xFFFC, 0xFFFE):
    work.append((rd16(v), 'native'))
# dispatch table
a = DISPATCH
while rd(a) != 0:
    claim(a, 'data', 3); work.append((rd16(a + 1), 'native')); a += 3
claim(a, 'data', 1)
for i in range(KEYTAB[1]):
    work.append((rd16(KEYTAB[0] + 2 * i), 'native'))
claim(KEYTAB[0], 'data', 2 * KEYTAB[1])
claim(0xFFF8, 'data', 8)
trace()

covered = sorted(kind)
gaps = []
a = BASE
while a <= 0xFFFF:
    if a not in kind:
        s = a
        while a <= 0xFFFF and a not in kind: a += 1
        gaps.append((s, a - s))
    else:
        a += 1
counts = {}
for a, (k, n) in kind.items(): counts[k] = counts.get(k, 0) + 1
os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
json.dump({'kind': {('%04X' % a): v for a, v in sorted(kind.items()) if v[1]}, 'gaps': gaps},
          open(os.path.join(ROOT, 'build', 'map.json'), 'w'))
if __name__ == '__main__':
    print('bytes by kind:', counts, ' unclassified:', 8192 - len(kind))
    for n in notes[:40]: print('  note:', n)
    for s, n in gaps:
        print('%04X-%04X %4d  %s' % (s, s + n - 1, n, rom[s - BASE:s - BASE + min(n, 20)].hex(' ')))
