// Shared constants. Every module imports from here instead of hard-coding values.
// Units: meters, seconds, radians (unless a name says Deg). World axes: +Y up.

export const WORLD = {
  size: 12000,        // terrain is a square of this side length, centered on the origin
  seaLevel: 0,        // water surface height
  maxHeight: 900,     // tallest mountain peaks
  fogNear: 1500,
  fogFar: 9000,
};

// Main runway: centered on the origin, runs along the Z axis.
// Take-off direction is toward -Z (heading 0 = north = -Z).
export const RUNWAY = {
  x: 0,
  z: 0,
  length: 1400,
  width: 45,
  elevation: 20,      // terrain is flattened to exactly this height around the runway
  flatRadius: 1100,   // terrain is fully flat inside this distance from the runway centerline area
};

// Where the player starts: on the south end of the runway, facing -Z.
export const SPAWN = {
  x: 0,
  z: RUNWAY.length / 2 - 60,
  heading: 0,
};

export const AIR_DENSITY = 1.225;
export const GRAVITY = 9.81;
