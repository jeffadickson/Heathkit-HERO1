"""MC6800 opcode table shared by the disassembler and assembler.

Each entry: opcode -> (mnemonic, mode)
modes: inh, imm8, imm16, dir, idx, ext, rel
"""
OPS = {}

def _add(op, mn, mode):
    OPS[op] = (mn, mode)

_inh = {0x01: "NOP", 0x06: "TAP", 0x07: "TPA", 0x08: "INX", 0x09: "DEX", 0x0A: "CLV", 0x0B: "SEV",
        0x0C: "CLC", 0x0D: "SEC", 0x0E: "CLI", 0x0F: "SEI", 0x10: "SBA", 0x11: "CBA", 0x16: "TAB",
        0x17: "TBA", 0x19: "DAA", 0x1B: "ABA", 0x30: "TSX", 0x31: "INS", 0x32: "PULA", 0x33: "PULB",
        0x34: "DES", 0x35: "TXS", 0x36: "PSHA", 0x37: "PSHB", 0x39: "RTS", 0x3B: "RTI", 0x3E: "WAI",
        0x3F: "SWI"}
for o, m in _inh.items():
    _add(o, m, "inh")
for i, m in enumerate(["BRA", None, "BHI", "BLS", "BCC", "BCS", "BNE", "BEQ", "BVC", "BVS", "BPL",
                       "BMI", "BGE", "BLT", "BGT", "BLE"]):
    if m:
        _add(0x20 + i, m, "rel")
_rmw = {0x0: "NEG", 0x3: "COM", 0x4: "LSR", 0x6: "ROR", 0x7: "ASR", 0x8: "ASL", 0x9: "ROL", 0xA: "DEC",
        0xC: "INC", 0xD: "TST", 0xF: "CLR"}
for lo, m in _rmw.items():
    _add(0x40 + lo, m + "A", "inh")
    _add(0x50 + lo, m + "B", "inh")
    _add(0x60 + lo, m, "idx")
    _add(0x70 + lo, m, "ext")
_add(0x6E, "JMP", "idx")
_add(0x7E, "JMP", "ext")
_alu = {0x0: "SUB", 0x1: "CMP", 0x2: "SBC", 0x4: "AND", 0x5: "BIT", 0x6: "LDA", 0x7: "STA", 0x8: "EOR",
        0x9: "ADC", 0xA: "ORA", 0xB: "ADD"}
_modes = ["imm8", "dir", "idx", "ext"]
for hi in range(8):
    acc = "A" if hi < 4 else "B"
    for lo, m in _alu.items():
        if lo == 7 and hi % 4 == 0:
            continue
        _add(0x80 + hi * 16 + lo, m + acc, _modes[hi % 4])
for base, m in [(0x8C, "CPX"), (0x8E, "LDS"), (0x8F, "STS"), (0xCE, "LDX"), (0xCF, "STX")]:
    for j, md in enumerate(["imm16", "dir", "idx", "ext"]):
        if m in ("STS", "STX") and j == 0:
            continue
        _add(base + 16 * j, m, md)
_add(0x8D, "BSR", "rel")
_add(0xAD, "JSR", "idx")
_add(0xBD, "JSR", "ext")

LEN = {"inh": 1, "rel": 2, "imm8": 2, "dir": 2, "idx": 2, "imm16": 3, "ext": 3}

# reverse map for the assembler: (mnemonic, mode) -> opcode
REV = {}
for o, (m, md) in OPS.items():
    REV[(m, md)] = o

assert len(OPS) == 197, len(OPS)
