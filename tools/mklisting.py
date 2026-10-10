#!/usr/bin/env python3
"""Generate the commented source for the HERO 1 ROM from a ROM image plus annotations.

  python3 tools/mklisting.py HERO.ROM annotations/hero1.ann > src/hero1.asm

Annotation file (one directive per line, '#' comments):
  E  NAME value             equate (RAM variable, I/O port, constant)
  L  addr NAME              label for a ROM address
  R  start end kind [n]     region kind: code robot fcb fdb str phon (n = bytes per line)
  O  addr expr              operand text override for the instruction at addr
  C  addr text              end-of-line comment
  H  addr                   routine header: following lines starting with ';' (verbatim)
  B  addr text              block comment line(s) placed before addr (repeatable)
"""
import json, os, sys, re
sys.path.insert(0, os.path.dirname(__file__))
from m6800 import OPS, LEN

BASE = 0xE000
ROBOT_LEN = {0x02: 1, 0x03: 1, 0x04: 1, 0x05: 1, 0x1C: 2, 0x1D: 2, 0x1E: 2, 0x1F: 2, 0x21: 1, 0x3A: 1,
             0x41: 1, 0x42: 1, 0x45: 1, 0x4B: 1, 0x4E: 1, 0x51: 1, 0x52: 1, 0x55: 1, 0x5B: 1, 0x5E: 1,
             0x61: 2, 0x62: 2, 0x71: 3, 0x72: 3, 0x83: 1, 0x87: 3, 0x8F: 3, 0xC3: 3, 0xCC: 3, 0xD3: 3,
             0xDC: 3, 0xE3: 2, 0xEC: 2, 0xF3: 3, 0xFC: 3, 0xFD: 8}
RNAME = {0x02: "ABORT DRIVE", 0x03: "ABORT STEERING", 0x04: "ABORT ARM", 0x05: "ABORT SPEECH",
         0x21: "ZERO", 0x3A: "RETURN TO EXECUTIVE", 0x41: "ENABLE LIGHT", 0x42: "ENABLE SOUND",
         0x45: "ENABLE SONAR", 0x4B: "ENABLE MOTION", 0x4E: "ENABLE DISPLAY", 0x51: "DISABLE LIGHT",
         0x52: "DISABLE SOUND", 0x55: "DISABLE SONAR", 0x5B: "DISABLE MOTION", 0x5E: "DISABLE DISPLAY",
         0x83: "CHANGE TO MACHINE LANGUAGE"}
MOT = ["DRIVE", "EXTEND", "SHOULDER", "ROTATE", "PIVOT", "GRIPPER", "HEAD", "STEERING"]
PH = ["EH3","EH2","EH1","PA0","DT","A1","A2","ZH","AH2","I3","I2","I1","M","N","B","V","CH","SH","Z","AW1","NG","AH1","OO1","OO","L","K","J","H","G","F","D","S","A","AY","Y1","UH3","AH","P","O","I","U","Y","T","R","E","W","AE","AE1","AW2","UH2","UH1","UH","O2","O1","IU","U1","THV","TH","ER","EH","E1","AW","PA1","STOP"]

def load_ann(path):
    A = {'E': {}, 'L': {}, 'R': [], 'O': {}, 'C': {}, 'H': {}, 'B': {}, 'N': set()}
    lines = open(path).read().splitlines() if path and os.path.exists(path) else []
    i = 0
    while i < len(lines):
        ln = lines[i]; i += 1
        if not ln.strip() or ln.lstrip().startswith('#'): continue
        d, rest = ln.split(None, 1) if ' ' in ln.strip() else (ln.strip(), '')
        if d == 'E':
            n, v = rest.split(None, 1); A['E'][n] = v.split('#')[0].strip()
        elif d == 'L':
            a, n = rest.split()[:2]; A['L'][int(a, 16)] = n
        elif d == 'R':
            p = rest.split('#')[0].split(); A['R'].append((int(p[0], 16), int(p[1], 16), p[2], int(p[3]) if len(p) > 3 else 8))
        elif d == 'N':
            A['N'].add(int(rest.split()[0], 16))
        elif d == 'O':
            a, e = rest.split(None, 1); A['O'][int(a, 16)] = e.strip()
        elif d == 'C':
            a, t = rest.split(None, 1); A['C'][int(a, 16)] = t
        elif d == 'B':
            a, t = (rest.split(None, 1) + [''])[:2]; A['B'].setdefault(int(a, 16), []).append(t)
        elif d == 'H':
            a = int(rest.split()[0], 16); body = []
            while i < len(lines) and lines[i].startswith(';'):
                body.append(lines[i]); i += 1
            A['H'][a] = body
    return A

REGP, MEAS = {}, {}

def derived_lines(a, labels):
    k = '%04X' % a
    r = REGP.get(k)
    if not r: return []
    m = MEAS.get(k)
    nm = lambda x: labels.get(int(x, 16), '$' + x)
    out = []
    if m:
        br = MEAS_BR.get(k)
        tag = '[static + measured: {:,} call{}{}]'.format(m['calls'], '' if m['calls'] == 1 else 's',
              (', %d/%d branches' % br) if br else '')
    else:
        tag = '[static]'
    ch = r['changes'][:]
    flags = r['flags']
    chs = ', '.join(ch + (['flags ' + ' '.join(flags)] if flags else [])) or 'nothing'
    part = (' ; on some paths: ' + ', '.join(r['partial'])) if r['partial'] else ''
    out.append(';')
    out.append('; Changes:   %s%s' % (chs, part))
    if a in VECTORS and 'RTI' in r['exits']:
        # an interrupt handler: the hardware frame saves everything and RTI restores it
        ch = [x for x in ch if x not in ('A', 'B', 'X')]
        out[-1] = '; Changes:   flags ' + ' '.join(f for f in flags if f != 'I') + ' only inside the handler (RTI restores CC)'
        out.append('; Saves:     CC, B, A, X, PC (7-byte hardware frame); restored by RTI')
        out.append('; Preserves: A, B, X, CC for the interrupted code   %s' % tag)
        r = dict(r, preserves=['A', 'B', 'X'], changes=[])
    else:
        out.append('; Preserves: %s   %s' % (', '.join(r['preserves']) or 'none', tag))
    if m:
        extra = [x for x in m['exitDiff'] if x in r['preserves']]
        if extra:
            out.append(';            ** measured: %s differed at exit on some call **' % ', '.join(extra))
        same = [x for x in r['changes'] if x not in m['exitDiff'] and x in m['written']]
        if same:
            out.append(';            measured: %s written but equal at exit on every call' % ', '.join(same))
    out.append('; Stack:     %d byte%s max, including callees%s' % (r['stack'], '' if r['stack'] == 1 else 's', (' (observed %d)' % m['stack']) if m else ''))
    if m and m['cycles'][1]:
        lo, hi = m['cycles']
        rng = ('{:,} E cycles on every call'.format(lo) if lo == hi else '{:,}-{:,} E cycles'.format(lo, hi))
        out.append('; Cycles:    observed %s over %s calls, including callees and waits,' % (rng, '{:,}'.format(m['calls'])))
        out.append(';            excluding interrupts taken meanwhile   [measured]')
    ex = [e.replace('tail-JMP to ', 'tail-JMP to ').replace('falls into ', 'falls into ') for e in r['exits']]
    hooks = [e.split('$')[-1] for e in ex if e.startswith('calls RAM hook')]
    ex = [re_sub_addr(e, nm) for e in ex if not e.startswith('calls RAM hook')]
    out.append('; Exit:      %s' % ('; '.join(ex) or 'none'))
    cl_ = [nm(c) for c in r['calls']] + ['RAM hook $%s' % h for h in hooks]
    if cl_: out.append('; Calls:     %s' % ', '.join(cl_))
    if r['callers']:
        cl = ', '.join(nm(c) for c in r['callers'])
        out.append('; Called from: %s' % cl)
    return out

def re_sub_addr(text, nm):
    return re.sub(r'\b([0-9A-F]{4})\b', lambda mm: nm(mm.group(1)), text)

MEAS_BR = {}
VECTORS = set()

def main():
    rom = open(sys.argv[1], 'rb').read()
    for v in (0x1FF8, 0x1FFA, 0x1FFC): VECTORS.add((rom[v] << 8) | rom[v + 1])
    root0 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    rp = os.path.join(root0, 'build', 'regpass.json'); mp_ = os.path.join(root0, 'build', 'measured.json')
    if os.path.exists(rp): REGP.update(json.load(open(rp)))
    if os.path.exists(mp_):
        mj = json.load(open(mp_)); MEAS.update(mj['routines'])
        # branch coverage per routine: conditional branches inside the routine body (static range to next entry)
        brs = {int(k, 16): v for k, v in mj['branches'].items()}
        ents = sorted(int(k, 16) for k in REGP)
        for i, e in enumerate(ents):
            hi = ents[i + 1] if i + 1 < len(ents) else 0x10000
            seen = [(b, v) for b, v in brs.items() if e <= b < hi]
            if seen:
                both = sum(1 for b, v in seen if v['taken'] and v['not'])
                MEAS_BR['%04X' % e] = (both, len(seen))
    A = load_ann(sys.argv[2] if len(sys.argv) > 2 else None)
    # merge every fragment in annotations/parts/ (drafted per subsystem)
    pdir = os.path.join(os.path.dirname(os.path.abspath(sys.argv[2])) if len(sys.argv) > 2 else '.', 'parts')
    if os.path.isdir(pdir):
        for fn in sorted(os.listdir(pdir)):
            if fn.endswith('.ann'):
                B = load_ann(os.path.join(pdir, fn))
                for k in ('E', 'L', 'O', 'C', 'H'):
                    for kk, vv in B[k].items():
                        if kk in A[k] and A[k][kk] != vv and k != 'H':
                            sys.stderr.write('annotation clash %s %s in %s\n' % (k, kk, fn))
                        A[k].setdefault(kk, vv)
                for kk, vv in B['B'].items(): A['B'].setdefault(kk, []).extend(vv)
                A['R'] += B['R']; A['N'] |= B['N']
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    mp = json.load(open(os.path.join(root, 'build', 'map.json')))
    rd = lambda a: rom[a - BASE]
    rd16 = lambda a: (rd(a) << 8) | rd(a + 1)
    # unit list: start -> (kind, length)
    kind = {}
    for k, (kd, n) in mp['kind'].items():
        kind[int(k, 16)] = (kd, n)
    for s, e, kd, per in A['R']:            # manual regions override the trace
        for a in list(kind):
            if s <= a <= e: del kind[a]
        if kd in ('code', 'robot'):
            a = s
            while a <= e:
                op = rd(a)
                n = ROBOT_LEN[op] if kd == 'robot' and op in ROBOT_LEN else LEN[OPS[op][1]] if op in OPS else 1
                kind[a] = (kd if op in OPS or kd == 'robot' else 'fcb', n); a += n
        else:
            kind[s] = (kd, e - s + 1, per)
    # fill unclassified bytes as fcb
    covered = set()
    for a, v in kind.items():
        covered.update(range(a, a + v[1]))
    a = BASE
    while a <= 0xFFFF:
        if a not in covered:
            s = a
            while a <= 0xFFFF and a not in covered: a += 1
            kind[s] = ('fcb', a - s, 8)
        else:
            a += 1
    starts = sorted(kind)
    # labels: annotations + every branch/jump/table target in ROM
    labels = dict(A['L'])
    unit_of = {}
    for a in starts:
        for i in range(kind[a][1]): unit_of[a + i] = a
    def want(t):
        if not (BASE <= t <= 0xFFFF): return
        u = unit_of.get(t, t)          # a target inside an instruction or table gets its unit labelled
        if u not in labels:
            labels[u] = 'L%04X' % u
    for a in starts:
        kd, n = kind[a][:2]
        if kd in ('code', 'robot'):
            op = rd(a)
            if kd == 'robot' and op in ROBOT_LEN:
                if op in (0x1C, 0x1D, 0x1E, 0x1F):
                    o = rd(a + 1); want((a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF)
                if op in (0x71, 0x72): want(rd16(a + 1))
                continue
            mn, md = OPS[op]
            if md == 'rel':
                o = rd(a + 1); want((a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF)
            if md in ('ext',) and rd16(a + 1) >= BASE: want(rd16(a + 1))
            if md == 'imm16' and rd16(a + 1) >= BASE and a not in A['N']: want(rd16(a + 1))
    for e in A['O'].values():               # @XXXX in an operand override names a ROM address
        for m in re.finditer(r'@([0-9A-Fa-f]{4})', e): want(int(m.group(1), 16))
    for a in starts:
        kd, n = kind[a][:2]
        if kd == 'fdb':
            for i in range(0, n, 2): want(rd16(a + i))
        if kd == 'optab':
            for i in range(0, n - 1, 3): want(rd16(a + i + 1))
    eqs = {}
    for n, v in A['E'].items():
        eqs[int(v.replace('$', ''), 16) if v.startswith('$') else int(v)] = n
    def sym(v, allow_ram=True):
        if v in labels and v in kind: return labels[v]
        if BASE <= v <= 0xFFFF and v in unit_of and unit_of[v] in labels:
            return '%s+%d' % (labels[unit_of[v]], v - unit_of[v])
        if allow_ram and v in eqs: return eqs[v]
        return None
    for kk in list(A['C']) + list(A['H']) + list(A['B']):
        if kk not in kind:
            sys.stderr.write('annotation at %04X is not the start of an instruction or data unit\n' % kk)
    out = []
    w = out.append
    w('* HERO 1 system ROM, version 1.0  ($E000-$FFFF)')
    w('* Heath Company ET-18, 1982.  Generated by tools/mklisting.py from the ROM image and')
    w('* annotations/hero1.ann.  Assemble with tools/asm6800.py.')
    w('')
    for n, v in sorted(A['E'].items(), key=lambda x: int(x[1].replace('$', ''), 16) if x[1].startswith('$') else int(x[1])):
        w('%-12s EQU  %s' % (n, v))
    w('')
    w('            ORG  $E000+ROMSHIFT')
    def fmt_ops(a, kd):
        op = rd(a)
        if a in A['O']:
            mn = OPS[op][0] if kd == 'code' or op not in ROBOT_LEN else None
            if mn: return mn, re.sub(r'@([0-9A-Fa-f]{4})', lambda m: sym(int(m.group(1), 16)) or '$' + m.group(1), A['O'][a])
        mn, md = OPS[op]
        if md == 'inh': return mn, ''
        if md == 'rel':
            o = rd(a + 1); t = (a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF
            return mn, sym(t) or '$%04X' % t
        if md == 'imm8': return mn, '#$%02X' % rd(a + 1)
        if md == 'imm16':
            v = rd16(a + 1); s = sym(v, allow_ram=False) if v >= BASE and a not in A['N'] else None
            return mn, '#' + (s or '$%04X' % v)
        if md == 'dir':
            v = rd(a + 1); return mn, eqs.get(v) or '$%02X' % v
        if md == 'idx': return mn, '$%02X,X' % rd(a + 1)
        v = rd16(a + 1); s = sym(v)
        if s: return mn, ('>' + s) if v < 0x100 else s
        return mn, ('>$%04X' % v) if v < 0x100 else '$%04X' % v
    for a in starts:
        kd = kind[a][0]; n = kind[a][1]
        for t in A['B'].get(a, []): w('* ' + t if t else '*')
        if a in A['H']:
            w('')
            body = A['H'][a]
            gen = derived_lines(a, labels)
            # insert the generated lines just before the closing rule
            if body and body[-1].startswith(';---'):
                for t in body[:-1]: w(t)
                for t in gen: w(t)
                w(body[-1])
            else:
                for t in body: w(t)
                for t in gen: w(t)
        lab = (labels[a] + ':') if a in labels else ''
        cmt = A['C'].get(a)
        bytes_ = rom[a - BASE:a - BASE + n]
        if kd == 'code' or (kd == 'robot' and rd(a) not in ROBOT_LEN):
            mn, opnd = fmt_ops(a, kd)
            line = '%-12s %-5s %s' % (lab, mn, opnd)
            if kd == 'robot' and not cmt: cmt = '(interpreted)'
        elif kd == 'robot':
            op = rd(a); line = '%-12s FCB   %s' % (lab, ','.join('$%02X' % b for b in bytes_))
            # operand expressions for addresses so the shift test can move them
            if op in (0x71, 0x72, 0xF3, 0xFC):
                t = rd16(a + 1); s = sym(t)
                if s: line = '%-12s FCB   $%02X,HI(%s),LO(%s)' % (lab, op, s, s)
            if op in (0x1C, 0x1D, 0x1E, 0x1F):
                o = rd(a + 1); t = (a + 2 + (o - 256 if o > 127 else o)) & 0xFFFF; s = sym(t)
                if s: line = '%-12s FCB   $%02X,%s-*-2' % (lab, op, s)
            rc = robot_comment(bytes_)
            cmt = rc + ('  ' + cmt if cmt else '')
        elif kd == 'str':
            line = '%-12s FCB   %s' % (lab, ','.join('$%02X' % b for b in bytes_))
            cmt = cmt or 'display "%s"' % seg_text(bytes_)
        elif kd == 'phon':
            line = '%-12s FCB   %s' % (lab, ','.join('$%02X' % b for b in bytes_))
            cmt = cmt or 'speech: ' + phon_text(bytes_)
        else:
            per = kind[a][2] if len(kind[a]) > 2 else 8
            if kd == 'optab':           # Robot Interpreter dispatch: opcode byte, handler word; $00 ends
                i = 0; first = True
                while i < n:
                    if i + 3 <= n:
                        h = rd16(a + i + 1)
                        w('%-12s FCB   $%02X' % (lab if first else '', bytes_[i]) + '   ; ' + (robot_comment(bytes([bytes_[i], 0, 0, 0, 0, 0, 0, 0])) or ''))
                        w('%-12s FDB   %s' % ('', sym(h) or '$%04X' % h)); i += 3
                    else:
                        w('%-12s FCB   $%02X   ; end of table' % ('', bytes_[i])); i += 1
                    first = False
                continue
            if kd == 'fdb':
                words = [rd16(a + i) for i in range(0, n, 2)]
                chunks = [words[i:i + per] for i in range(0, len(words), per)]
                first = True
                for ch in chunks:
                    w('%-12s FDB   %s' % (lab if first else '', ','.join(sym(x) or '$%04X' % x for x in ch)) + ('   ; ' + cmt if cmt and first else ''))
                    first = False
                continue
            chunks = [bytes_[i:i + per] for i in range(0, n, per)]
            first = True
            for ch in chunks:
                w('%-12s FCB   %s' % (lab if first else '', ','.join('$%02X' % b for b in ch)) + ('   ; ' + cmt if cmt and first else ''))
                first = False
            continue
        w(line + ('   ; ' + cmt if cmt else ''))
    print('\n'.join(out))
    json.dump({('%04X' % a): [kind[a][0], kind[a][1]] for a in starts}, open(os.path.join(root, 'build', 'units.json'), 'w'))

SEG = {0x7E: 'O', 0x30: '1', 0x6D: '2', 0x79: '3', 0x33: '4', 0x5B: 'S', 0x5F: '6', 0x70: '7', 0x7F: '8', 0x7B: '9',
       0x77: 'A', 0x1F: 'b', 0x4E: 'C', 0x3D: 'd', 0x4F: 'E', 0x47: 'F', 0x37: 'H', 0x0E: 'L', 0x05: 'r', 0x3B: 'y',
       0x1D: 'o', 0x0F: 't', 0x00: ' ', 0x01: '-', 0x67: 'P', 0x15: 'n', 0x3E: 'U', 0x1C: 'u', 0x0D: 'c', 0x17: 'h',
       0x06: 'I', 0x10: 'i', 0x5E: 'G', 0x20: "'", 0x76: 'N', 0x08: '_', 0x3C: 'J', 0x0C: 'l'}
def seg_text(bs):
    return ''.join(SEG.get(b & 0x7F, '?') + ('.' if b & 0x80 else '') for b in bs)
def phon_text(bs):
    out = []; i = 0
    while i < len(bs):
        b = bs[i]
        if b == 0xFF: out.append('[end]'); i += 1; continue
        if b == 0xBF and i + 2 < len(bs): out.append('[then $%02X%02X]' % (bs[i + 1], bs[i + 2])); i += 3; continue
        out.append(PH[b & 0x3F] + ("'" * (b >> 6))); i += 1
    return ' '.join(out)
def robot_comment(bs):
    op = bs[0]
    if op in RNAME: return RNAME[op]
    if op in (0x1C, 0x1D, 0x1E, 0x1F): return 'BRANCH IF %s BUSY' % ['DRIVE', 'STEERING', 'ARM', 'SPEECH'][op - 0x1C]
    if op in (0x71, 0x72): return 'SPEAK $%02X%02X%s' % (bs[1], bs[2], ', WAIT' if op == 0x72 else '')
    if op in (0x61, 0x62): return 'SPEAK $%02X,X%s' % (bs[1], ', WAIT' if op == 0x62 else '')
    if op == 0x87: return 'SLEEP %d x 10 s' % ((bs[1] << 8) | bs[2])
    if op == 0x8F: return 'PAUSE %d/16 s' % ((bs[1] << 8) | bs[2])
    if op == 0xFD: return 'MOVE ALL TO ' + ' '.join('%02X' % b for b in bs[1:])
    if op in (0xE3, 0xEC): return 'MOVE ABS $%02X,X%s' % (bs[1], ', WAIT' if op == 0xE3 else '')
    if op in (0xF3, 0xFC): return 'MOVE ABS ($%02X%02X)%s' % (bs[1], bs[2], ', WAIT' if op == 0xF3 else '')
    if op in (0xC3, 0xCC, 0xD3, 0xDC):
        w = (bs[1] << 8) | bs[2]; m = w >> 13; s = (w >> 11) & 3; d = (w >> 10) & 1; p = w & 0x3FF
        rel = (op & 0xF0) == 0xD0
        return 'MOVE %s %s%s $%03X %s%s' % (MOT[m], 'REL ' if rel else 'TO ', ('-' if d else '+') if rel else '', p,
                                           ['SLOW', 'SLOW', 'MED', 'FAST'][s], ', WAIT' if op & 0x0F == 3 else '')
    return ''

if __name__ == '__main__':
    main()
