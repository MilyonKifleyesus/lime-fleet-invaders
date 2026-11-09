// Player names: generated names that match the player's colour, and checks
// for typed names. The big screen runs these checks before a name is shown.
(function (root) {
  'use strict';

  const COLORS = ['amber', 'sky', 'jade', 'sun', 'cobalt', 'ember', 'orchid'];

  const PARTS = [
    'PISTON', 'GEARBOX', 'AXLE', 'DIESEL', 'CLUTCH', 'SPARK', 'TORQUE', 'TURBO', 'VALVE', 'BRAKE',
    'MUFFLER', 'RADIATOR', 'WIPER', 'FUSE', 'SPOKE', 'CHASSIS', 'BUMPER', 'IGNITION', 'CAMSHAFT', 'ROTOR',
    'HUBCAP', 'WRENCH', 'RATCHET', 'GASKET', 'BEARING', 'PULLEY', 'SHIFTER', 'THROTTLE', 'MIRROR', 'HEADLIGHT',
  ];

  function suggestName(color) {
    const part = PARTS[Math.floor(Math.random() * PARTS.length)];
    return `${color.toUpperCase()} ${part}`;
  }

  // Same list as the database, plus common French and Quebec French words.
  const CONTAINS = [
    'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'rapist', 'nazi', 'hitler',
    'asshole', 'bastard', 'pussy', 'porn', 'retard', 'tranny',
    'merde', 'putain', 'salope', 'connard', 'connasse', 'encule', 'batard', 'niquer', 'tabarnak', 'tabarnac',
    'calisse', 'ostie', 'chienne',
  ];
  const EXACT = [
    'kike', 'chink', 'spic', 'dick', 'cock', 'penis', 'rape', 'ass', 'sex',
    'pute', 'pd', 'fdp', 'nique', 'con', 'conne', 'criss', 'osti',
  ];

  const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

  function cleanName(raw) {
    return String(raw || '')
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function plain(name) {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[\s._'’\-*]/g, '')
      .replace(/[013457@$!|]/g, ch => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '|': 'i' })[ch]);
  }

  // Returns why a cleaned name is refused, or null when it is fine.
  function nameProblem(name) {
    const chars = [...name];
    if (chars.length < 1) return 'missing';
    if (chars.length > 16) return 'long';
    if (/[\p{Cc}\p{Cf}<>&"\\/{}[\]`]/u.test(name)) return 'invalid';
    if (!/[\p{L}\p{N}]/u.test(name)) return 'invalid';
    const p = plain(name);
    const squeezed = p.replace(/(.)\1+/g, '$1');
    for (const v of [p, squeezed]) {
      if (EXACT.includes(v)) return 'not_allowed';
      if (CONTAINS.some(w => v.includes(w))) return 'not_allowed';
    }
    return null;
  }

  root.FleetNames = { COLORS: COLORS, PARTS: PARTS, suggestName: suggestName, cleanName: cleanName, nameProblem: nameProblem };
})(typeof window !== 'undefined' ? window : globalThis);
