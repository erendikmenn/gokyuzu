"""Fin planform functions (station s vs height z above the fuselage axis). Pure python; shared by empennage.py and
textures.py. From the AC side view: straight LE slope 0.731 from (31.46, 3.36) to the rounded tip at z 8.10,
TE 35.52 + 0.217 (z - 2.38), rudder hinge 33.77 + 0.416 (z - 2.38), dorsal fillet from s 27.9."""
import math
import numpy as np

FIN_Z0, FIN_ZTIP = 1.40, 8.10


def fin_le(z):
    if z >= 3.36:
        le = 31.46 + 0.731 * (z - 3.36)
        if z > 7.85:
            k = (z - 7.85) / (FIN_ZTIP - 7.85)
            le += 0.36 * (1 - math.sqrt(max(0.0, 1 - k * k)))
        return le
    zz = [1.40, 1.95, 2.10, 2.30, 2.60, 2.95, 3.36]
    ss = [27.9, 28.55, 29.15, 29.85, 30.55, 31.05, 31.46]
    return float(np.interp(z, zz, ss))


def fin_te(z):
    return 35.52 + 0.217 * (z - 2.38)


def fin_hinge(z):
    return 33.77 + 0.416 * (z - 2.38)
