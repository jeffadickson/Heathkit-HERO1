# Heathkit HERO 1 — the system ROM, demystified

A study of the 8 KB system ROM (version 1.0, $E000–$FFFF) of the Heathkit HERO 1 / ET-18 educational
robot (1982), part of the *Assembly Demystified* series.

- **`src/hero1.asm`** — fully commented, relabelled MC6800 listing of the ROM. It reassembles byte for
  byte, and it still runs correctly when assembled 16 KB lower (the shift test), so no address is left
  as a bare number.
- **`emulator/`** — JavaScript MC6800/6808 core and a HERO 1 hardware model (keypad, six-digit display,
  stepper and drive motors, SC-01 speech, sonar, MSM5832 clock, interrupt flags) that runs the real ROM.
- **`web/hero1.html`** — the explainer page with an in-browser emulator (loads the ROM when supplied,
  otherwise a high-level model). `web/src/` holds its sources.
- **`annotations/`** — labels, comments and routine headers keyed by ROM address, which
  `tools/mklisting.py` merges into the listing.

## What the ROM does

The HERO 1 extends the 6800 with a *Robot Language*: the opcodes Motorola left undefined become robot
commands (move, speak, sense). `SWI` enters the interpreter at `RSTEP` ($E000). Robot opcodes are looked
up in `ROBOT_TAB` ($E03C). Every ordinary 6800 instruction in a robot program is single-stepped by
`SSTEP` ($F83C), which copies it onto the stack followed by an `SWI` and `RTI`s into it. Motors are
scheduled from the 1,024 Hz interrupt (`IRQ`, $EFC9), and speech is streamed phoneme by phoneme to the
Votrax SC-01.

## Build

Requires Python 3 (tested 3.13) and Node.js (tested 22).

    make listing    # regenerate src/hero1.asm from HERO.ROM + annotations
    make regpass    # static register pass, then regenerate the listing with derived header lines
    make measure    # run every scenario on the emulator and log per-routine registers/cycles (slow)
    make verify     # byte-identical rebuild + shift test
    make coverage   # code/data coverage gate

| File      | SHA-256                                                            | CRC32    |
|-----------|--------------------------------------------------------------------|----------|
| HERO.ROM  | `39e45595efc26a8fcfd7f3dc8e36f7d2b73ce98ee2a999b7089c090c832e1180` | 83F865A1 |

## Licences

Tools, emulator and build code: MIT (see `LICENSE`). Book text, annotations and commentary: © Jeff
Dickson, all rights reserved. The HERO 1 ROM and Heath documentation keep their own status; see
`RIGHTS.md`. No licence to them is granted.
