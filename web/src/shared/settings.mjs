// Cosmos's own settings: defaults and validation (GALAXY_CONTRACT §1b).
//
// Pure module: no three, no DOM, no Node built-ins. The server validates every
// POST /api/settings with it and the settings panel uses the same rules, so a
// value the panel accepts is a value the server saves.

export const SETTINGS_DEFAULTS = Object.freeze({ v: 1,
  idle:     Object.freeze({ hours: 24, kMin: 0.5, kMax: 1.6, kSlope: 0.35 }),
  storm:    Object.freeze({ count: 3, windowS: 20, holdS: 10, decayS: 2 }),   // same values as lib/config.js STORM
  timeouts: Object.freeze({ stalledS: 600, ambiguousS: 30, shipActiveS: 90, shipDoneS: 240, noRegistryWorkingS: 600 }),
  arms:     Object.freeze({}),   // { [armKey]: { slot?: 0..11, name?: string } }  owner overrides; auto slots live in cache/layout.json
  sound:    Object.freeze({ enabled: false, volume: 0.5, ambient: true, chime: true }),
  notify:   Object.freeze({ crash: true, needs: true, needsAfterS: 60 }),
  render:   Object.freeze({ quality: 'high', fpsCap: 60, idleFps: 10, maxFullSystems: 6, dof: true, deepSky: true, pip: true, constellations: true, spend: false }),
  labels:   Object.freeze({ enabled: true, density: 'normal', numbers: true, sessions: 'hover' }),   // density: 'sparse'|'normal'|'dense'
  explain:  Object.freeze({ model: 'haiku' }),
});

/**
 * Rules for every leaf. num: [min, max, integer?]; enum: allowed strings;
 * bool; list: allowed strings for a string array. Exported so the settings
 * panel can show ranges and choices next to each field.
 */
export const SETTINGS_RULES = Object.freeze({
  idle: {
    hours:  { num: [1, 24 * 14] },
    kMin:   { num: [0.05, 5] },
    kMax:   { num: [0.05, 5] },
    kSlope: { num: [0, 5] },
  },
  storm: {
    count:   { num: [2, 50, true] },
    windowS: { num: [1, 3600] },
    holdS:   { num: [0, 600] },
    decayS:  { num: [0, 60] },
  },
  timeouts: {
    stalledS:           { num: [30, 86400] },
    ambiguousS:         { num: [5, 3600] },
    shipActiveS:        { num: [5, 3600] },
    shipDoneS:          { num: [5, 86400] },
    noRegistryWorkingS: { num: [30, 86400] },
  },
  notify: {
    crash:       { bool: true },
    needs:       { bool: true },
    needsAfterS: { num: [10, 3600, true] },
  },
  sound: {
    enabled: { bool: true },
    volume:  { num: [0, 1] },
    ambient: { bool: true },
    chime:   { bool: true },
  },
  render: {
    quality:        { enum: ['high', 'medium', 'low'] },
    fpsCap:         { num: [15, 240, true] },
    idleFps:        { num: [1, 60, true] },
    maxFullSystems: { num: [1, 16, true] },
    dof:            { bool: true },
    deepSky:        { bool: true },
    pip:            { bool: true },
    constellations: { bool: true },
    spend:          { bool: true },
  },
  labels: {
    enabled: { bool: true },
    density: { enum: ['sparse', 'normal', 'dense'] },
    numbers: { bool: true },
    sessions: { enum: ['hover', 'always'] },
  },

  explain: {
    model: { enum: ['haiku', 'sonnet', 'opus'] },
  },
});

const ARM_NAME_MAX = 80;
const ARM_KEY_MAX = 1024;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Plain deep copy of a JSON-shaped value (unfrozen). */
function copy(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

function checkLeaf(rule, val, where, errors) {
  if (rule.num) {
    const [min, max, int] = rule.num;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      errors.push(`${where} must be a number.`); return undefined;
    }
    if (int && !Number.isInteger(val)) { errors.push(`${where} must be a whole number.`); return undefined; }
    if (val < min || val > max) { errors.push(`${where} must be between ${min} and ${max}.`); return undefined; }
    return val;
  }
  if (rule.bool) {
    if (typeof val !== 'boolean') { errors.push(`${where} must be true or false.`); return undefined; }
    return val;
  }
  if (rule.enum) {
    if (!rule.enum.includes(val)) { errors.push(`${where} must be one of: ${rule.enum.join(', ')}.`); return undefined; }
    return val;
  }
  if (rule.list) {
    if (!Array.isArray(val) || val.some((v) => !rule.list.includes(v))) {
      errors.push(`${where} must be a list drawn from: ${rule.list.join(', ')}.`); return undefined;
    }
    return [...new Set(val)];
  }
  return undefined;
}

function checkArms(patch, base, errors) {
  const out = copy(base) ?? {};
  if (!isPlainObject(patch)) { errors.push('arms must be an object keyed by project path.'); return out; }
  for (const [key, v] of Object.entries(patch)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > ARM_KEY_MAX) {
      errors.push('arms has an invalid project key.'); continue;
    }
    if (v === null) { delete out[key]; continue; }          // null removes an override
    if (!isPlainObject(v)) { errors.push(`arms["${key}"] must be an object.`); continue; }
    const cur = isPlainObject(out[key]) ? { ...out[key] } : {};
    let bad = false;
    for (const [f, fv] of Object.entries(v)) {
      if (f === 'slot') {
        if (fv === null) delete cur.slot;
        else if (Number.isInteger(fv) && fv >= 0 && fv <= 11) cur.slot = fv;
        else { errors.push(`arms["${key}"].slot must be a whole number from 0 to 11.`); bad = true; }
      } else if (f === 'name') {
        if (fv === null || fv === '') delete cur.name;
        else if (typeof fv === 'string' && fv.trim().length > 0 && fv.length <= ARM_NAME_MAX) cur.name = fv.trim();
        else { errors.push(`arms["${key}"].name must be text up to ${ARM_NAME_MAX} characters.`); bad = true; }
      } else {
        errors.push(`arms["${key}"].${f} is not a setting.`); bad = true;
      }
    }
    if (bad) continue;
    if (Object.keys(cur).length === 0) delete out[key];
    else out[key] = cur;
  }
  // Two projects pinned to the same slot would draw on top of each other.
  const seen = new Map();
  for (const [key, v] of Object.entries(out)) {
    if (v.slot === undefined) continue;
    if (seen.has(v.slot)) errors.push(`arms: slot ${v.slot} is pinned by two projects (${seen.get(v.slot)} and ${key}).`);
    else seen.set(v.slot, key);
  }
  return out;
}

/**
 * Deep-merge `patch` onto `base`, keeping only known keys and valid types.
 * Invalid or unknown fields are dropped and reported in plain English.
 * @returns {{ value: object, errors: string[] }}  value is a fresh plain object.
 */
export function validateSettings(patch, base = SETTINGS_DEFAULTS) {
  const errors = [];
  // Start from the defaults, then base, so a partial or older base gains new keys.
  const value = copy(SETTINGS_DEFAULTS);
  const src = isPlainObject(base) ? base : {};
  const apply = (p, isBase) => {
    if (!isPlainObject(p)) { if (!isBase) errors.push('Settings must be a JSON object.'); return; }
    for (const [group, gv] of Object.entries(p)) {
      if (group === 'v') continue;
      if (group === 'arms') { value.arms = checkArms(gv, value.arms, isBase ? [] : errors); continue; }
      const rules = SETTINGS_RULES[group];
      if (!rules) { if (!isBase) errors.push(`"${group}" is not a settings group.`); continue; }
      if (!isPlainObject(gv)) { if (!isBase) errors.push(`${group} must be an object.`); continue; }
      for (const [leaf, lv] of Object.entries(gv)) {
        const rule = rules[leaf];
        if (!rule) { if (!isBase) errors.push(`${group}.${leaf} is not a setting.`); continue; }
        const ok = checkLeaf(rule, lv, `${group}.${leaf}`, isBase ? [] : errors);
        if (ok !== undefined) value[group][leaf] = ok;
      }
    }
  };
  apply(src, true);
  if (patch !== undefined && patch !== null) apply(patch, false);
  // Cross-field rule: the idle curve's bounds must not cross.
  if (value.idle.kMin > value.idle.kMax) {
    errors.push('idle.kMin must not be larger than idle.kMax.');
    const fallback = isPlainObject(src.idle) ? src.idle : SETTINGS_DEFAULTS.idle;
    value.idle.kMin = Math.min(fallback.kMin ?? SETTINGS_DEFAULTS.idle.kMin, fallback.kMax ?? SETTINGS_DEFAULTS.idle.kMax);
    value.idle.kMax = Math.max(fallback.kMin ?? SETTINGS_DEFAULTS.idle.kMin, fallback.kMax ?? SETTINGS_DEFAULTS.idle.kMax);
  }
  value.v = 1;
  return { value, errors };
}

/** Rules for limits.json (the context-limit table the settings panel edits). */
export function validateLimits(file) {
  const errors = [];
  if (!isPlainObject(file)) return { value: null, errors: ['limits must be a JSON object.'] };
  const def = file.default;
  if (!Number.isInteger(def) || def < 1000 || def > 100_000_000) {
    errors.push('limits.default must be a whole number of tokens between 1 000 and 100 000 000.');
  }
  if (!Array.isArray(file.rules)) errors.push('limits.rules must be a list.');
  const rules = [];
  if (Array.isArray(file.rules)) {
    if (file.rules.length > 100) errors.push('limits.rules can hold at most 100 rules.');
    file.rules.slice(0, 100).forEach((r, i) => {
      if (!isPlainObject(r)) { errors.push(`limits.rules[${i}] must be an object.`); return; }
      const okMatch = typeof r.match === 'string' && r.match.length > 0 && r.match.length <= 120
        && /^[A-Za-z0-9._\-*[\]@:/]+$/.test(r.match);
      const okLimit = Number.isInteger(r.limit) && r.limit >= 1000 && r.limit <= 100_000_000;
      if (!okMatch) errors.push(`limits.rules[${i}].match must be a model name pattern (letters, digits, . - _ [ ] and * as a wildcard).`);
      if (!okLimit) errors.push(`limits.rules[${i}].limit must be a whole number of tokens between 1 000 and 100 000 000.`);
      if (okMatch && okLimit) rules.push({ match: r.match, limit: r.limit });
    });
  }
  if (errors.length) return { value: null, errors };
  return { value: { v: 1, default: def, rules }, errors };
}
