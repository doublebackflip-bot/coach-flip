// Sport registry. Adding a sport = drop its KB JSON in data/ and a rules module in js/sports/<id>/.
// `kbs`: knowledge bases to load (first = main). Kickboxing and MMA also load the boxing KB
// because they reuse the boxing punch checks.
export const SPORTS = [
  { id: 'boxing', name: 'Boxing', icon: '🥊', kbs: ['data/boxing.json'], module: './boxing/module.js', ready: true },
  { id: 'softball', name: 'Softball', icon: '🥎', kbs: ['data/softball.json'], module: './softball/module.js', ready: true },
  { id: 'sprinting', name: 'Sprinting', icon: '⚡', kbs: ['data/sprinting.json'], module: './sprinting/module.js', ready: true },
  { id: 'distance_running', name: 'Distance running', icon: '🏃', kbs: ['data/distance_running.json'], module: './distance_running/module.js', ready: true },
  { id: 'soccer', name: 'Soccer', icon: '⚽', kbs: ['data/soccer.json'], module: './soccer/module.js', ready: true },
  { id: 'jumping', name: 'Jumping', icon: '🦘', kbs: ['data/jumping.json'], module: './jumping/module.js', ready: true },
  { id: 'kickboxing', name: 'Kickboxing', icon: '🦵', kbs: ['data/kickboxing.json', 'data/boxing.json'], module: './kickboxing/module.js', ready: true },
  { id: 'mma', name: 'MMA', icon: '🤼', kbs: ['data/mma.json', 'data/boxing.json'], module: './mma/module.js', ready: true },
  { id: 'bjj', name: 'Jiu-jitsu', icon: '🥋', kbs: ['data/bjj.json'], module: './bjj/module.js', ready: true },
];
export const sportEntry = (id) => SPORTS.find((x) => x.id === id);
export async function loadSportModule(id) {
  const s = sportEntry(id);
  if (!s || !s.ready) throw new Error(`${id} is not available yet`);
  const mod = await import(s.module);
  return mod.default;
}
