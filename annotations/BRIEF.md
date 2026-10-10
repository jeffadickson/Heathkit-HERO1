# Annotation brief: HERO 1 system ROM v1.0

You are drafting commentary for one subsystem of the Heathkit HERO 1 robot's 8 KB system ROM
($E000-$FFFF, Motorola MC6808, 1982). The listing must stay byte-identical; you only add annotations.

## Where things are (project root /home/claude/hero1-rom)
- `src/hero1.asm` - current generated listing (auto labels `Lxxxx`). Regenerate with `make listing`.
- `HERO.ROM` - the ROM. `node tools/peek.js START END n` disassembles a range (`r` = start in Robot Language).
- `emulator/herohw.js` + `emulator/cpu6800.js` - hardware emulator that runs this ROM (see the `rom/` tests
  in `tests/scenarios.js` for how to script keys, robot programs and interrupts). Use it to confirm behavior.
- `build/regpass.json` - static per-routine register summary. `build/units.json` - code/data map.
- `reference/tech.txt` - OCR of Heath's Technical Manual (programming chapters, Robot Interpreter table,
  ROM routine descriptions, theory of operation, memory and port maps). `reference/faq.txt` - owners' FAQ.
- Port map (from schematics/FAQ, confirmed by running the ROM): $C003/$C005/$C006 keypad rows (active low),
  $C110-$C16F display latches (digit 0 = $C16x leftmost ... digit 5 = $C11x; latch address bits 0-2 = segment bit),
  $C200 interrupt flags (read) / clear+enable mask (write): bit0 sonar, 1 motion, 2 motor-battery low,
  3 logic-battery low, 4 1024 Hz clock tick, 5 pendant trigger, 6 drive encoder, 7 experimental board;
  $C220 sonar count; $C240 sense A/D (read) and SC-01 phoneme (write); $C260 write: steering phases (7-4),
  pivot/rotate phases (3-0); read: limit switches (6 steer CW, 5 arm up, 4 head CCW, 3 steer CCW, 2 arm down,
  1 head CW, 0 speech request); $C280 write: extend/head phases (7-4), gripper/shoulder (3-0); read: pendant/remote,
  bit 1 sleep switch (1 = normal), bit 0 trigger; $C2A0 drive (bit7 reverse, bit6 on, 5-0 speed);
  $C2C0 control (bit7 select rotate/shoulder/head, bit6 select pivot/gripper/extend, bit5 speech strobe,
  3-0 clock register); $C2E0 power (7 eye/ear select, 6 sleep, 5 sense, 4 display, 3 speech, 2 motion, 1 sonar,
  0 tape out); $C300 MSM5832 clock.
- Interpreter facts already established: robot opcode dispatch table at $E03C (op, handler) ends with $00;
  $E000 is the per-instruction interpreter step; $F83C single-steps a native instruction by copying it onto
  the stack followed by SWI ($3F) and RTI-ing into it; RAM $0FF4 points at the user's SWI register frame
  (CC,B,A,XH,XL,PCH,PCL at +1..+7 relative to the saved SP); $0B holds busy bits (bit0 drive, bit1 steering,
  bit2 arm channel, bit3 speech); motor control blocks at $0EE4 (steering) and $0EF0 (arm channel) are filled
  from an 11-byte-per-motor descriptor table at $E2AA; RAM hooks at $0012, $0015, $0018, $001B, $001E, $0021,
  $0024 and user vectors $0027 motion, $002A trigger, $002D experimental, $0030/$0033/$0036 user keys.
  Opcode $55 actually disables SONAR and $5B disables MOTION (the manual's table has them swapped; its errata agrees).

## What to write
Write ONLY your fragment file `annotations/parts/<name>.ann` (given in your task). Directives, one per line:

    E  NAME $ADDR   # comment          RAM variable or constant name (UPPER_CASE)
    L  ADDR NAME                        label for a ROM address (UPPER_CASE, <= 12 chars preferred)
    C  ADDR text                        end-of-line comment for the instruction/data at ADDR
    B  ADDR text                        block comment line placed above ADDR (repeat for several lines)
    R  START END kind [n]               only if you find mis-classified data/code (kind fcb fdb str phon code robot)
    O  ADDR expr                        operand override (e.g. #LO(@F19B)); use @XXXX to name a ROM address
    H  ADDR                             routine header; the following lines, each starting with ';', form it

Header format (do NOT write Changes/Preserves/Stack/Calls/Called-from/Exit lines - they are generated from
the static pass and the emulator log):

    H  F7C8
    ;---------------------------------------------------------------
    ; OUTCH - light one display digit with a raw segment pattern
    ;
    ; One or two sentences of plain-language purpose and method.
    ;
    ; In:        A = segment pattern (bit 6 = a ... bit 0 = g, bit 7 = point)
    ;            DIGADD ($0FF2) = latch address of the digit
    ; Out:       DIGADD moved to the next digit                    (contract)
    ; Memory:    writes $0FEE (X save), DIGADD; writes display latches
    ;---------------------------------------------------------------

Rules
- Every routine (every call target, dispatch handler and RTS-dispatch target) in your range gets a header.
- Comment every JSR/BSR with what the callee does. Comment line by line wherever the purpose isn't obvious.
- Use `$` hex throughout. Name flags H I N Z V C explicitly.
- Mark tricks: skipped-byte tricks (e.g. CPX # hiding instructions), self-modifying code, inline strings,
  RTS dispatch, code that runs in Robot Language, interrupt-masking windows.
- Do not guess silently: if something is an inference, say "probably" or "(inference)". Confirm what you can
  by running the emulator; mention the experiment briefly in a comment if it settled a question.
- Keep the build green: after writing, run `make listing verify` and fix any clash or failure you caused.
- Finish with a short report (<= 400 words): what the subsystem does, the 3-5 most interesting findings with
  addresses, anything you could not resolve, and the names you introduced.
