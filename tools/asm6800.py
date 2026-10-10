#!/usr/bin/env python3
"""Small two-pass MC6800 assembler for the HERO 1 study.

Syntax (Motorola style, upper or lower case):
  label  EQU  expr
         ORG  expr
  label: OP   operand   ; comment         (colon optional; '*' in column 1 = comment line)
  Operands:  #expr  immediate      expr,X  indexed      expr  direct/extended (direct when < $100)
             >expr  force extended <expr  force direct
  Data:      FCB expr,...   FDB expr,...   FCC "text"   RMB n
  Expr:      $hex  %bin  decimal  'c'  label  *  + - * / & |  HI(e)  LO(e)  ( )
Output: raw binary image covering every ORG'd byte, written with -o; a listing with -l.
"""
import re, sys
from m6800 import REV, LEN

class AsmError(Exception):
    pass

TOK = re.compile(r"\s*(HI\(|LO\(|\$[0-9A-Fa-f]+|%[01]+|\d+|'.'|[A-Za-z_.][A-Za-z0-9_.]*|\*|[-+/&|()])", re.I)

def evaluate(expr, syms, pc, strict):
    expr = expr.strip()
    toks = []
    i = 0
    while i < len(expr):
        m = TOK.match(expr, i)
        if not m or m.end() == i:
            raise AsmError("bad expression: " + expr)
        toks.append(m.group(1)); i = m.end()
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        t = toks[pos[0]]; pos[0] += 1; return t

    def atom():
        t = take()
        if t == '(':
            v = binop(); take(); return v
        if t.upper() in ('HI(', 'LO('):
            t = t.upper()
            v = binop(); take()
            return (v >> 8) & 0xFF if t == 'HI(' else v & 0xFF
        if t == '-':
            return -atom()
        if t == '*':
            return pc
        if t.startswith('$'): return int(t[1:], 16)
        if t.startswith('%'): return int(t[1:], 2)
        if t.startswith("'"): return ord(t[1])
        if t[0].isdigit(): return int(t)
        key = t.upper()
        if key in syms: return syms[key]
        if strict: raise AsmError("undefined symbol " + t)
        return 0xFFFF            # forward reference in pass 1: assume a full 16-bit address

    def binop():
        v = atom()
        while peek() in ('+', '-', '*', '/', '&', '|'):
            op = take(); r = atom()
            v = {'+': v + r, '-': v - r, '*': v * r, '/': v // r if r else 0, '&': v & r, '|': v | r}[op]
        return v
    v = binop()
    if pos[0] != len(toks):
        raise AsmError("trailing tokens in " + expr)
    return v

def split_operands(s):
    out, depth, cur, q = [], 0, '', False
    for ch in s:
        if ch == '"': q = not q
        if ch == '(' and not q: depth += 1
        if ch == ')' and not q: depth -= 1
        if ch == ',' and depth == 0 and not q:
            out.append(cur); cur = ''
        else:
            cur += ch
    out.append(cur)
    return [o.strip() for o in out]

LINE = re.compile(r"^(?:([A-Za-z_.][A-Za-z0-9_.]*):?)?\s*(?:([A-Za-z]+)\s*(.*?))?\s*$")

def strip_comment(line):
    q = False
    for i, ch in enumerate(line):
        if ch in "\"'": q = not q if ch == '"' else q
        if ch == ';' and not q:
            return line[:i]
    return line

def assemble(text):
    lines = text.splitlines()
    syms = {}
    for pass_no in (1, 2):
        strict = pass_no == 2
        pc = 0; image = {}; listing = []
        for n, raw in enumerate(lines, 1):
            line = strip_comment(raw).rstrip()
            if not line.strip() or raw[:1] in ('*', ';'):
                listing.append((None, b'', raw)); continue
            if line[0] in ' \t':
                label = None; rest = line.strip()
            else:
                m = re.match(r"([A-Za-z_.][A-Za-z0-9_.]*):?\s*(.*)$", line)
                label, rest = m.group(1).upper(), m.group(2)
            parts = rest.split(None, 1)
            op = parts[0].upper() if parts else ''
            arg = parts[1].strip() if len(parts) > 1 else ''
            try:
                if op == 'EQU':
                    syms[label] = evaluate(arg, syms, pc, strict); listing.append((None, b'', raw)); continue
                if label:
                    if pass_no == 1 and label in syms and syms[label] != pc:
                        raise AsmError("duplicate label " + label)
                    syms[label] = pc
                if not op:
                    listing.append((pc, b'', raw)); continue
                start = pc; out = b''
                if op == 'ORG':
                    pc = evaluate(arg, syms, pc, True); listing.append((None, b'', raw)); continue
                elif op == 'RMB':
                    pc += evaluate(arg, syms, pc, True); listing.append((start, b'', raw)); continue
                elif op == 'FCB':
                    out = bytes(evaluate(e, syms, pc, strict) & 0xFF for e in split_operands(arg))
                elif op == 'FDB':
                    b = []
                    for e in split_operands(arg):
                        v = evaluate(e, syms, pc, strict) & 0xFFFF; b += [v >> 8, v & 0xFF]
                    out = bytes(b)
                elif op == 'FCC':
                    s = arg.strip(); out = s[1:-1].encode('latin-1')
                else:
                    out = encode(op, arg, syms, pc, strict)
                for i, v in enumerate(out):
                    a = (pc + i) & 0xFFFF
                    if pass_no == 2 and a in image:
                        raise AsmError("overlapping output at $%04X" % a)
                    image[a] = v
                pc += len(out)
                listing.append((start, out, raw))
            except AsmError as e:
                raise AsmError("line %d: %s\n  %s" % (n, e, raw))
    return image, listing, syms

def encode(op, arg, syms, pc, strict):
    def opc(mode):
        if (op, mode) not in REV:
            raise AsmError("no %s form of %s" % (mode, op))
        return REV[(op, mode)]
    if (op, 'inh') in REV and arg == '':
        return bytes([opc('inh')])
    if (op, 'rel') in REV:
        t = evaluate(arg, syms, pc, strict); off = t - (pc + 2)
        if strict and not -128 <= off <= 127:
            raise AsmError("branch out of range")
        return bytes([opc('rel'), off & 0xFF])
    if arg.startswith('#'):
        v = evaluate(arg[1:], syms, pc, strict)
        if (op, 'imm16') in REV:
            return bytes([opc('imm16'), (v >> 8) & 0xFF, v & 0xFF])
        return bytes([opc('imm8'), v & 0xFF])
    ops = split_operands(arg)
    if len(ops) == 2 and ops[1].upper() == 'X':
        v = evaluate(ops[0], syms, pc, strict) if ops[0] else 0
        if strict and not 0 <= v <= 255:
            raise AsmError("index offset out of range")
        return bytes([opc('idx'), v & 0xFF])
    force = None
    if arg.startswith('>'): force, arg = 'ext', arg[1:]
    elif arg.startswith('<'): force, arg = 'dir', arg[1:]
    v = evaluate(arg, syms, pc, strict)
    mode = force or ('dir' if 0 <= v < 0x100 and (op, 'dir') in REV else 'ext')
    if mode == 'dir':
        return bytes([opc('dir'), v & 0xFF])
    return bytes([opc('ext'), (v >> 8) & 0xFF, v & 0xFF])

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('-o', '--out'); ap.add_argument('-l', '--list')
    ap.add_argument('--start', type=lambda s: int(s, 0)); ap.add_argument('--end', type=lambda s: int(s, 0))
    ap.add_argument('-D', action='append', default=[], help='NAME=value predefined symbol')
    a = ap.parse_args()
    text = open(a.src).read()
    pre = ''.join('%s EQU %s\n' % tuple(d.split('=', 1)) for d in a.D)
    try:
        image, listing, syms = assemble(pre + text)
    except AsmError as e:
        print("error:", e, file=sys.stderr); sys.exit(1)
    lo = a.start if a.start is not None else min(image); hi = a.end if a.end is not None else max(image)
    data = bytes(image.get(x, 0xFF) for x in range(lo, hi + 1))
    if a.out: open(a.out, 'wb').write(data)
    if a.list:
        with open(a.list, 'w') as f:
            for addr, b, raw in listing:
                f.write(('%04X %-12s ' % (addr, b[:4].hex(' ').upper()) if addr is not None else ' ' * 18) + raw + '\n')

if __name__ == '__main__':
    main()
