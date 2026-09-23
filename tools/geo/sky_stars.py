"""Time & weather: star field for the night sky from the Yale Bright Star Catalogue (5th rev., public domain,
CDS catalogue V/50). Download once: data/sf/raw/bsc5/catalog.gz (https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz).

Writes assets/sf/sky/stars.bin: float32 records [ex, ey, ez, vmag, b_v] per star (J2000 equatorial unit vector, x toward
the vernal equinox, z toward the north celestial pole), brightest first; read by src/world-sf/environment-night.js.
"""
import gzip, math, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'data/sf/raw/bsc5/catalog.gz'
OUT = ROOT / 'assets/sf/sky/stars.bin'
MAG_LIMIT = float(sys.argv[1]) if len(sys.argv) > 1 else 5.9


def field(line, a, b):
    return line[a - 1:b].strip()


def main():
    stars = []
    with gzip.open(SRC, 'rt', encoding='latin-1') as f:
        for line in f:
            try:
                rah, ram, ras = field(line, 76, 77), field(line, 78, 79), field(line, 80, 83)
                if not rah:
                    continue          # novae / removed entries have no position
                sign = -1.0 if field(line, 84, 84) == '-' else 1.0
                ded, dem, des = field(line, 85, 86), field(line, 87, 88), field(line, 89, 90)
                vmag = float(field(line, 103, 107))
                bv_s = field(line, 110, 114)
                bv = float(bv_s) if bv_s else 0.6
            except ValueError:
                continue
            if vmag > MAG_LIMIT:
                continue
            ra = (int(rah) + int(ram) / 60 + float(ras) / 3600) * 15 * math.pi / 180
            dec = sign * (int(ded) + int(dem) / 60 + int(des) / 3600) * math.pi / 180
            stars.append((math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec), vmag, bv))
    stars.sort(key=lambda s: s[3])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'wb') as f:
        for s in stars:
            f.write(struct.pack('<5f', *s))
    print(f'{len(stars)} stars (V <= {MAG_LIMIT}) -> {OUT} ({OUT.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
