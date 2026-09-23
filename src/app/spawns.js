// Lead-owned: start positions derived from data/sf/runways.json.
// A spawn is { id, name, x, z, heading (rad), altitude? (m MSL, airborne), speed? (m/s) }.
const rad = (d) => d * Math.PI / 180;

export function buildSpawns(runways) {
  const list = [];
  const runway = (icao, ident, name) => {
    const apt = runways.airports.find((a) => a.icao === icao);
    for (const r of apt.runways) for (const e of r.ends) {
      if (e.ident !== ident) continue;
      const h = rad(e.headingTrue);
      const back = 45; // meters down the runway from the threshold
      list.push({ id: `${icao}-${ident}`, name, x: e.x + Math.sin(h) * back, z: e.z - Math.cos(h) * back, heading: h, airport: icao });
    }
  };
  runway('KSFO', '28R', 'SFO · Pist 28R (batı, körfez)');
  runway('KSFO', '28L', 'SFO · Pist 28L');
  runway('KSFO', '01R', 'SFO · Pist 01R (kuzey, şehre doğru)');
  runway('KNGZ', '24', 'Alameda Hava Üssü · Pist 24 (SF silueti)');
  runway('KNGZ', '06', 'Alameda Hava Üssü · Pist 06');
  runway('KOAK', '30', 'Oakland · Pist 30');
  // airborne starts
  // heading 100°: through the strait, crossing the bridge mid-span (075° pointed at the Marin Headlands, bridge off-screen)
  list.push({ id: 'AIR-GGB', name: 'Havada · Golden Gate yaklaşımı (450 m)', x: -14500, z: -23500, heading: rad(100), altitude: 450, airborne: true });
  list.push({ id: 'AIR-SFO-FINAL', name: 'Havada · SFO 28L son yaklaşma', x: 1464 + Math.sin(rad(117.4)) * 9000, z: 796 - Math.cos(rad(117.4)) * 9000, heading: rad(297.4), altitude: 480, airborne: true });
  list.push({ id: 'AIR-CITY', name: 'Havada · Şehir merkezi üstü (600 m)', x: -1500, z: -14500, heading: rad(340), altitude: 600, airborne: true });
  return list;
}
