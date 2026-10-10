#!/usr/bin/env python3
"""Static register pass over the HERO 1 ROM.

For each routine entry, walk every path and track where each of A, B and X comes from:
  'in'      the caller's value (never written, or restored)
  ('m', M)  reloaded from RAM address M
  'w'       written with something else
PSHx/PULx carry sources, so a push/pull pair restores. A routine that stores a register while it
still holds the caller's value (STX $0FEE at entry) and later reloads it from the same address
(LDX $0FEE) restores it too; the summary records that as 'in', so callers inherit it.
Callers apply callee summaries. Output build/regpass.json, per entry:
  changes, partial (changed on some paths only), preserves, flags, stack, calls, callers, exits
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from m6800 import OPS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rom = open(os.path.join(ROOT, 'HERO.ROM'), 'rb').read()
BASE = 0xE000
rd = lambda a: rom[a - BASE]
rd16 = lambda a: (rd(a) << 8) | rd(a + 1)
units = {int(k, 16): v for k, v in json.load(open(os.path.join(ROOT, 'build', 'units.json'))).items()}
REGS = ('A', 'B', 'X')

def flags_of(mn):
    if mn == 'ABA' or mn[:3] in ('ADD', 'ADC'): return 'HNZVC'
    if mn in ('SBA', 'CBA') or mn[:3] in ('SUB', 'SBC', 'CMP', 'NEG'): return 'NZVC'
    if mn in ('TAB', 'TBA') or mn[:3] in ('AND', 'BIT', 'EOR', 'ORA', 'LDA', 'STA'): return 'NZV'
    if mn == 'DAA' or mn[:3] in ('CLR', 'COM', 'LSR', 'ASR', 'ASL', 'ROL', 'ROR', 'TST'): return 'NZVC'
    if mn in ('CPX', 'LDX', 'LDS', 'STX', 'STS'): return 'NZV'
    if mn in ('INX', 'DEX'): return 'Z'
    if mn[:3] in ('DEC', 'INC'): return 'NZV'
    if mn in ('CLC', 'SEC'): return 'C'
    if mn in ('CLV', 'SEV'): return 'V'
    if mn in ('CLI', 'SEI', 'SWI'): return 'I'
    if mn in ('TAP', 'RTI'): return 'HINZVC'
    return ''

def dest(mn, md):
    if mn in ('TBA', 'ABA', 'SBA', 'DAA', 'TPA'): return {'A'}
    if mn == 'TAB': return {'B'}
    if mn in ('INX', 'DEX', 'TSX'): return {'X'}
    if mn == 'RTI': return set(REGS)
    if mn[-1] in 'AB':
        b = mn[:-1]
        if b in ('ADD', 'ADC', 'SUB', 'SBC', 'AND', 'ORA', 'EOR'): return {mn[-1]}
        if b in ('NEG', 'COM', 'LSR', 'ASR', 'ASL', 'ROL', 'ROR', 'DEC', 'INC', 'CLR') and md == 'inh': return {mn[-1]}
    return set()

entries = set()
for a, (k, n) in units.items():
    if k != 'code': continue
    mn, md = OPS[rd(a)]
    if mn in ('JSR', 'JMP') and md == 'ext' and rd16(a + 1) in units: entries.add(rd16(a + 1))
    if mn == 'BSR':
        o = rd(a + 1); entries.add((a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF)
for v in (0xFFF8, 0xFFFC, 0xFFFE): entries.add(rd16(v))
for a, (k, n) in units.items():
    if k == 'optab':
        for i in range(0, n - 1, 3): entries.add(rd16(a + i + 1))
    if k == 'fdb':
        for i in range(0, n, 2): entries.add(rd16(a + i))
extra = os.path.join(ROOT, 'annotations', 'entries.txt')
if os.path.exists(extra):
    for ln in open(extra):
        if ln.strip() and not ln.startswith('#'): entries.add(int(ln.split()[0], 16))
entries = {e for e in entries if e in units and units[e][0] == 'code'}

def next_unit(a):
    b = a + units[a][1]
    while b in units and units[b][0] == 'str': b += units[b][1]
    return b

def saved_slots(e):
    """RAM slots where e stores a register while it still holds the caller's value (straight-line prologue)"""
    slots = {}; a = e; n = 0; held = {'A': True, 'B': True, 'X': True}
    while a in units and units[a][0] == 'code' and n < 12:
        mn, md = OPS[rd(a)]; n += 1
        addr = rd(a + 1) if md == 'dir' else rd16(a + 1) if md == 'ext' else None
        if mn in ('STX', 'STAA', 'STAB') and addr is not None:
            r = 'X' if mn == 'STX' else mn[-1]
            if held[r]: slots[addr] = r
        for r in dest(mn, md): held[r] = False
        if mn in ('LDAA', 'LDAB', 'LDX'): held['X' if mn == 'LDX' else mn[-1]] = False
        if mn in ('JSR', 'BSR', 'JMP', 'RTS', 'RTI') or md == 'rel': break
        a += units[a][1]
    return slots

summ = {}; active = set()

def analyse(e):
    if e in summ: return summ[e]
    if e in active:
        return {'final': {r: {'w'} for r in REGS}, 'flags': 'HINZVC', 'stack': 0, 'exits': {'recursive'}, 'calls': set(), 'complete': True}
    active.add(e)
    final = {r: set() for r in REGS}
    flags, calls, exits = set(), set(), set()
    maxstack = 0; seen = set(); budget = 80000
    work = [(e, (('A', 'in'), ('B', 'in'), ('X', 'in')), (), 0, ())]   # pc, sources, push stack, depth, saved slots
    while work and budget:
        budget -= 1
        st = work.pop()
        if st in seen: continue
        seen.add(st)
        a, src, stk, depth, slots = st
        src = dict(src); stk = list(stk); slots = dict(slots)
        if a != e and a in entries: exits.add('falls into %04X' % a)
        if a not in units or units[a][0] != 'code':
            exits.add('runs into data %04X' % a); continue
        mn, md = OPS[rd(a)]
        flags.update(flags_of(mn))
        for r in dest(mn, md): src[r] = 'w'
        addr = rd(a + 1) if md == 'dir' else rd16(a + 1) if md == 'ext' else None
        if mn in ('STX', 'STAA', 'STAB') and addr is not None:
            r = 'X' if mn == 'STX' else mn[-1]
            if src[r] == 'in': slots[addr] = r            # the caller's value is now saved at addr
            else: slots.pop(addr, None)
        if mn in ('LDAA', 'LDAB', 'LDX'):
            r = 'X' if mn == 'LDX' else mn[-1]
            src[r] = 'in' if addr is not None and slots.get(addr) == r else ('m', addr) if addr is not None else 'w'
        if mn in ('PSHA', 'PSHB'):
            stk.append(src[mn[-1]]); depth += 1
        elif mn in ('PULA', 'PULB'):
            src[mn[-1]] = stk.pop() if stk else 'w'; depth -= 1
            if depth < 0: exits.add('pulls caller stack')
        elif mn == 'INS':
            if stk: stk.pop()
            depth -= 1
        elif mn == 'DES':
            stk.append('w'); depth += 1
        maxstack = max(maxstack, depth)
        nxt = next_unit(a)
        def push(t, s=None, d=None):
            s = src if s is None else s
            work.append((t, tuple(sorted(s.items())), tuple(stk), depth if d is None else d, tuple(sorted(slots.items()))))
        if mn in ('JSR', 'BSR'):
            t = rd16(a + 1) if md == 'ext' else ((a + 2 + ((rd(a + 1) - 256) if rd(a + 1) > 127 else rd(a + 1))) & 0xFFFF) if md == 'rel' else None
            if t is None or t not in units:
                exits.add('indirect JSR at %04X' % a if t is None else 'calls RAM hook $%04X' % t)
                for r in REGS: src[r] = 'w'
                flags.update('HNZVC'); maxstack = max(maxstack, depth + 2)
                push(nxt); continue
            calls.add(t); cs = analyse(t)
            maxstack = max(maxstack, depth + 2 + cs['stack']); flags.update(cs['flags'])
            outs = [dict(src)]
            for r in REGS:
                opts = {src[r] if f == 'in' else ('in' if isinstance(f, tuple) and slots.get(f[1]) == r else f)
                        for f in (cs['final'][r] or {'in'})}
                outs = [dict(o, **{r: v}) for o in outs for v in opts]
            for o in outs: push(nxt, o)
            continue
        if mn in ('RTS', 'RTI', 'WAI', 'SWI'):
            exits.add(mn)
            for r in REGS: final[r].add(src[r])
            continue
        if mn == 'JMP':
            if md == 'ext' and rd16(a + 1) in units:
                t = rd16(a + 1); calls.add(t); exits.add('tail-JMP to %04X' % t)
                cs = analyse(t)
                maxstack = max(maxstack, depth + cs['stack']); flags.update(cs['flags'])
                for r in REGS:
                    for f in cs['final'][r] or {'in'}:
                        final[r].add(src[r] if f == 'in' else ('in' if isinstance(f, tuple) and slots.get(f[1]) == r else f))
            else:
                exits.add('indirect JMP at %04X' % a)
                for r in REGS: final[r].add('w')
            continue
        if md == 'rel':
            o = rd(a + 1); push((a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF)
            if mn == 'BRA': continue
        if mn == 'LDS': exits.add('resets SP')
        push(nxt)
    active.discard(e)
    res = {'final': final, 'flags': ''.join(f for f in 'HINZVC' if f in flags), 'stack': maxstack,
           'exits': exits, 'calls': calls, 'complete': budget > 0}
    summ[e] = res
    return res

for e in sorted(entries): analyse(e)
callers = {}
for e, r in summ.items():
    for c in r['calls']: callers.setdefault(c, set()).add(e)
out = {}
for e in sorted(entries):
    r = summ[e]; st = {}
    for reg in REGS:
        fs = r['final'][reg] or {'in'}
        st[reg] = {'kept' if f == 'in' else 'changed' for f in fs}
    out['%04X' % e] = {'changes': [x for x in REGS if 'changed' in st[x]],
                       'partial': [x for x in REGS if st[x] == {'kept', 'changed'}],
                       'preserves': [x for x in REGS if st[x] == {'kept'}],
                       'flags': r['flags'], 'stack': r['stack'],
                       'calls': sorted('%04X' % c for c in r['calls']),
                       'callers': sorted('%04X' % c for c in callers.get(e, ())),
                       'exits': sorted(r['exits']), 'complete': r['complete']}
json.dump(out, open(os.path.join(ROOT, 'build', 'regpass.json'), 'w'), indent=0)
if __name__ == '__main__':
    print('routines analysed:', len(out), ' incomplete:', [k for k, v in out.items() if not v['complete']])
    for k in sys.argv[1:]: print(k, json.dumps(out.get(k.upper())))
