"""Coverage gate: every ROM address the emulator executed must be the start of a code unit.
Also reports native code that never executed (UNREACHED) as contiguous ranges."""
import json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
units = {int(k, 16): v for k, v in json.load(open(os.path.join(ROOT, 'build', 'units.json'))).items()}
cov = {a for a, n in json.load(open(os.path.join(ROOT, 'build-coverage.json'))) if a >= 0xE000}
bad = [a for a in sorted(cov) if a not in units or units[a][0] not in ('code', 'robot')]
for a in bad[:20]:
    print('executed byte not a code unit: %04X (%s)' % (a, units.get(a)))
code = sorted(a for a, (k, n) in units.items() if k == 'code')
unreached = []; run = None
for a in code:
    if a not in cov:
        if run and run[1] == a: run[1] = a + units[a][1]
        else:
            run = [a, a + units[a][1]]; unreached.append(run)
    else:
        run = None
nb = sum(e - s for s, e in unreached)
print('coverage gate: %d executed addresses, %d not code units' % (len(cov), len(bad)))
print('UNREACHED native code: %d bytes in %d runs' % (nb, len(unreached)))
if '-v' in sys.argv:
    for s, e in unreached: print('  %04X-%04X %d' % (s, e - 1, e - s))
json.dump(unreached, open(os.path.join(ROOT, 'build', 'unreached.json'), 'w'))
sys.exit(1 if bad else 0)
