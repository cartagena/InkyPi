#!/usr/bin/env python3
"""Did that screenshot actually capture what it was asked for?

Three of the round-2 hand-off shots were the dashboard filed under a panel's name and
one was an empty sky, because `?open=` is driven by script and a headless screenshot is
taken on a clock that does not wait for it. Shooting is cheap; a review built on the
wrong picture is not, so every shot is now looked at by the shooter before it is kept.

The test is the panel TITLE, which is the one mark the dashboard never has in that
place: a panel opens with its name set large at the top-left, where the dashboard's
top bar carries nothing until the clock starts ~68 CSS px down. So: count the bright
pixels in a band across the top-left corner. A panel has hundreds; the dashboard, an
empty sky and a half-drawn boot all have almost none.

Only the first rows are decoded — PNG rows are filtered against the row above, so
reading the top of an image is cheap and reading the bottom is not. Pure stdlib: this
runs in whatever python3 the machine has, with no wheel to install.

  usage: check-shot.py <png> [home|panel]      exit 0 if it is what was asked for
"""
import sys, zlib, struct

BAND_Y, BAND_H = 16, 52          # the title's band, in CSS px from the top
BAND_X, BAND_W = 8, 400          # left of the close button, right of nothing else
BRIGHT = 140                     # a lit glyph, not a tinted sky
ENOUGH = 300                     # pixels of title ink; a real one runs to thousands


def read(path):
    """(width, pixels) where pixels[y][x] is a luminance byte, top BAND rows only."""
    raw = open(path, "rb").read()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a png: " + path)
    pos, idat, w, h, chan = 8, [], 0, 0, 0
    while pos < len(raw):
        ln = struct.unpack(">I", raw[pos:pos + 4])[0]
        typ = raw[pos + 4:pos + 8]
        body = raw[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, colour = struct.unpack(">IIBB", body[:10])
            if depth != 8:
                raise SystemExit("only 8-bit pngs: " + path)
            chan = {0: 1, 2: 3, 4: 2, 6: 4}[colour]
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"IEND":
            break
        pos += 12 + ln
    rows = BAND_Y + BAND_H
    data = zlib.decompressobj().decompress(b"".join(idat), (w * chan + 1) * rows)
    stride = w * chan
    prev, out = bytearray(stride), []
    for y in range(min(rows, h)):
        off = y * (stride + 1)
        f, line = data[off], bytearray(data[off + 1:off + 1 + stride])
        for i in range(stride):
            a = line[i - chan] if i >= chan else 0
            b = prev[i]
            c = prev[i - chan] if i >= chan else 0
            if f == 1:   line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        out.append(line)
    return w, chan, out


def title_ink(path):
    w, chan, rows = read(path)
    n = 0
    for y in range(BAND_Y, min(len(rows), BAND_Y + BAND_H)):
        line = rows[y]
        for x in range(BAND_X, min(w, BAND_X + BAND_W)):
            i = x * chan
            if chan >= 3:
                lum = (line[i] * 30 + line[i + 1] * 59 + line[i + 2] * 11) // 100
            else:
                lum = line[i]
            if lum >= BRIGHT:
                n += 1
    return n


if __name__ == "__main__":
    path = sys.argv[1]
    want = sys.argv[2] if len(sys.argv) > 2 else "panel"
    ink = title_ink(path)
    ok = (ink >= ENOUGH) if want == "panel" else (ink < ENOUGH)
    print(("ok" if ok else "BAD") + " " + want + " " + str(ink) + " " + path)
    sys.exit(0 if ok else 1)
