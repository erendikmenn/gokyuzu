"""Spanwise layout of the A320neo wing moving surfaces (right wing, meters from the centreline). Pure python;
shared by wing.py (geometry) and textures.py (outlines)."""
SLATS = [(2.30, 4.55), (6.85, 9.15), (9.18, 11.50), (11.53, 13.80), (13.83, 16.00)]
FLAPS = [(2.00, 6.40), (6.48, 12.40)]
SPOILERS = [(4.95, 6.36), (6.92, 8.28), (8.31, 9.67), (9.70, 11.03), (11.06, 12.36)]
AILERON = (12.52, 15.90)
FTF = [4.87, 8.30, 11.91]               # flap-track fairing span stations (AC planform dimensions)
XS = 0.12                               # slat chord fraction
X_SP0, X_SP1 = 0.62, 0.835              # spoiler hinge and trailing edge
X_FL_LOW = 0.72                         # flap: lower surface split
X_SHROUD = 0.835                        # fixed shroud trailing edge (no spoiler)
X_AIL = 0.745
