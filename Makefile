# HERO 1 ROM study
PY ?= python3
NODE ?= node
ROM ?= HERO.ROM

.PHONY: all listing verify shift coverage clean
all: verify

build/map.json: tools/trace.py build-coverage.json $(ROM)
	$(PY) tools/trace.py > build/trace.txt

listing src/hero1.asm: build/map.json annotations/hero1.ann $(wildcard annotations/parts/*.ann) tools/mklisting.py
	$(PY) tools/mklisting.py $(ROM) annotations/hero1.ann > src/hero1.asm

build/rebuild.bin: src/hero1.asm tools/asm6800.py
	cd tools && $(PY) asm6800.py ../src/hero1.asm -D ROMSHIFT=0 -o ../build/rebuild.bin --start 0xE000 --end 0xFFFF -l ../build/rebuild.lst

build/shifted.bin: src/hero1.asm tools/asm6800.py
	cd tools && $(PY) asm6800.py ../src/hero1.asm -D ROMSHIFT=-16384 -o ../build/shifted.bin --start 0xA000 --end 0xBFFF

verify: build/rebuild.bin build/shifted.bin
	cmp build/rebuild.bin $(ROM) && echo "byte-identical: PASS"
	$(NODE) tests/shift_test.js -16384

coverage:
	$(NODE) tools/coverage.js

clean:
	rm -rf build/*.bin build/*.lst

# derived header lines need the static pass, which needs the unit map from a first listing run
regpass build/regpass.json: src/hero1.asm tools/regpass.py
	$(PY) tools/regpass.py > /dev/null
	$(PY) tools/mklisting.py $(ROM) annotations/hero1.ann > src/hero1.asm

measure build/measured.json:
	$(NODE) tools/calllog.js
