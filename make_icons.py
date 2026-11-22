"""Draw the app icon (black tile, cream ring with a bar) as PNGs, no extra libraries."""
import struct
import zlib
from pathlib import Path

BG = (8, 9, 11)
FG = (207, 212, 219)


def png(size):
    c = size / 2
    r_out, r_in = size * 0.30, size * 0.22
    bar_h = size * 0.035
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x + 0.5 - c, y + 0.5 - c
            d = (dx * dx + dy * dy) ** 0.5
            on = r_in <= d <= r_out or (abs(dy) <= bar_h and abs(dx) <= r_out * 1.25)
            row += bytes(FG if on else BG)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


out = Path(__file__).resolve().parent / "site"
for s in (180, 192, 512):
    (out / f"icon-{s}.png").write_bytes(png(s))
print("icons written")
