// Runtime patches for experiments (applied inside a running game page by ab.mjs / capture.mjs; research only,
// nothing here is written to game code). Each is a self-contained function serialised with toString().
export const PATCHES = {
  // sky dome drawn after the opaque scene at the far plane (z = w) without writing gl_FragDepth → early-Z rejects every
  // pixel already covered by terrain/buildings (the dome stays depth-tested, LEQUAL against the cleared far depth)
  skylast: () => {
    const g = window.__game, d = g.scene.getObjectByName('sf-sky-dome'); if (!d) return 'no dome';
    const m = d.material;
    m.vertexShader = m.vertexShader.replace(/#include <logdepthbuf_vertex>/g, '').replace(/}\s*$/, '  gl_Position.z = gl_Position.w;\n}');
    m.fragmentShader = m.fragmentShader.replace(/#include <logdepthbuf_fragment>/g, '');
    m.depthTest = true; m.depthFunc = 515; m.needsUpdate = true;
    d.renderOrder = 1e6;
    return 'sky last';
  },
  nofogbank: () => { const b = window.__game.scene.getObjectByName('sf-fogbank'); if (b) b.visible = false; return 'fog bank hidden'; },
  noclouds: () => { const b = window.__game.scene.getObjectByName('sf-clouds'); if (b) b.visible = false; return 'clouds hidden'; },
  noshadowpass: () => { window.__game.renderer.shadowMap.autoUpdate = false; return 'shadow pass off'; },
  shadowhalf: () => {   // shadow maps refreshed every 2nd frame (cached in between)
    const r = window.__game.renderer; let n = 0;
    const f = () => { r.shadowMap.needsUpdate = (n++ & 1) === 0; requestAnimationFrame(f); };
    r.shadowMap.autoUpdate = false; f(); return 'shadow every 2nd frame';
  },
  notrees: () => { const t = window.__game.scene.getObjectByName('city_trees'); if (t) t.visible = false; return 'trees hidden'; },
  noaircraft: () => { const g = window.__game; g.rig.object.visible = false; return 'aircraft hidden'; },
  pr075: () => { window.__game.renderer.setPixelRatio(0.75); return 'pixel ratio 0.75'; },
  // terrain: skip the whole water computation (6-8 wave/foam/depth texture fetches, surf maths) for pure-land fragments
  // (sfLandA == 1, where the output is exactly the land colour); the uDebug view is dropped from the patched shader
  terrainbranch: () => {
    const g = window.__game;
    const fix = (s) => s
      .replace(/  if \(uDebug > 0\.5\) \{[\s\S]*?diffuseColor\.rgb = vec3\(dv\);\n  \}\n/, '')
      .replace('  // water\n', '  vec3 wcol = vec3(0.0); sfShore = 0.0; sfWaterN = vec3(0.0, 1.0, 0.0);\n  if (sfLandA < 1.0) {\n')
      .replace('  vec3 wcol = mix(uWaterShallow', '  wcol = mix(uWaterShallow')
      .replace('  wcol = mix(wcol, vec3(0.62), clamp(foam, 0.0, 1.0) * 0.85);\n', '  wcol = mix(wcol, vec3(0.62), clamp(foam, 0.0, 1.0) * 0.85);\n  }\n');
    const patch = () => {
      for (const m of g.world.terrain.object.children) {
        const mat = m.material;
        if (!mat || mat.name !== 'sf-terrain' || mat.__branch) continue;
        const ob = mat.onBeforeCompile;
        mat.onBeforeCompile = (sh, r) => { ob(sh, r); sh.fragmentShader = fix(sh.fragmentShader); };
        mat.customProgramCacheKey = () => 'sf-terrain-4-branch';
        mat.__branch = true; mat.needsUpdate = true;
      }
    };
    patch(); setInterval(patch, 300);
    return 'terrain land branch';
  },
  // water quality 'simple' path everywhere (upper bound of what the water shading costs at this pose)
  terrainsimple: () => { const g = window.__game; g.world.setQuality({ ...g.quality, water: 'simple' }); return 'water simple'; },
  // cockpit displays: no redraw/upload at all (upper bound of the avionics cost)
  noavionics: () => { for (const d of window.__game.displays || []) d.display.enabled = false; return 'avionics off'; },
  // cockpit displays keep 30 Hz but upload without mipmaps (linear filtering)
  avinomips: () => {
    for (const d of window.__game.displays || []) { const t = d.display.texture; t.generateMipmaps = false; t.minFilter = 1006; /* LinearFilter */ t.needsUpdate = true; }
    return 'avionics without mipmaps';
  },
  // cockpit displays at 15 Hz each, half of them per 30 Hz tick (round-robin: spreads the canvas uploads)
  avi15hz: () => {
    const ds = [...new Set((window.__game.displays || []).map((d) => d.display))];
    let tick = 0;
    ds.forEach((d, i) => { const up = d.update; d.update = function (...a) { if (i === 0) tick++; if ((tick + i) % 2) return; return up.apply(this, a); }; });
    return `avionics 15 Hz round-robin (${ds.length} displays)`;
  },
  // cockpit displays: every display on every 3rd 30 Hz tick (10 Hz, all at once: a third of the upload frames)
  avi10hz: () => {
    const ds = [...new Set((window.__game.displays || []).map((d) => d.display))];
    let tick = 0;
    ds.forEach((d, i) => { const up = d.update; d.update = function (...a) { if (i === 0) tick++; if (tick % 3) return; return up.apply(this, a); }; });
    return `avionics 10 Hz (${ds.length} displays)`;
  },
};
