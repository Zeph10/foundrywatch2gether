/** Pure, system-neutral encounter/cinematic rule evaluation. */
export const PHASE_DEFAULTS = [75, 50, 25];
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;
export const priority = (value, fallback = 50) => Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback));
export const uid = () => globalThis.crypto?.randomUUID?.() || `fwr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const cleanString = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0,n);
export function hpPercent(actor) {
  const hp = actor?.system?.attributes?.hp;
  const current = Number(hp?.value); const max = Number(hp?.max);
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return null;
  return Math.min(100, Math.max(0, current / max * 100));
}
/** What a combat threshold measures. "actor" is the profile's boss; the rest look at the whole fight. */
export const THRESHOLD_SOURCES = Object.freeze({
  actor: "Boss HP %",
  enemies: "All enemies' HP %",
  party: "Party's HP %",
  anyPc: "Lowest player character's HP %",
  enemiesRemaining: "Enemies still standing"
});
export const isPercentSource = source => source !== "enemiesRemaining";
const sourceOf = rule => THRESHOLD_SOURCES[rule?.source] ? rule.source : "actor";
const directionOf = rule => rule?.direction === "above" ? "above" : "below";

/** Did `value` move across `threshold` in the rule's direction? (falls to/below, or rises to/above) */
export function crosses(rule, previous, current) {
  const t = Number(rule.threshold);
  if (!Number.isFinite(t) || previous === null || current === null || previous === undefined || current === undefined) return false;
  return directionOf(rule) === "above" ? previous < t && current >= t : previous > t && current <= t;
}

/**
 * Boss-HP thresholds (source "actor") crossed between two HP percentages, once each per combat.
 * Sorted so the most extreme match is last: the lowest for "falls below", the highest for "rises above".
 */
export function crossedPhases(phases, previous, current, fired = new Set()) {
  if (previous === null || current === null || previous === current) return [];
  return (phases || []).filter(p => p.enabled !== false && sourceOf(p) === "actor" && Number(p.threshold) >= 0 &&
    Number(p.threshold) <= 100 && !fired.has(p.id) && crosses(p, previous, current))
    .sort((a, b) => directionOf(a) === directionOf(b)
      ? (directionOf(a) === "above" ? Number(a.threshold) - Number(b.threshold) : Number(b.threshold) - Number(a.threshold))
      : 0);
}

/**
 * Whole-fight measurements from combatants: [{hp, max, side: "enemy"|"party"|"neutral", pc, defeated}].
 * HP % values are pooled (total current ÷ total max). Missing data gives null, which never crosses.
 */
export function combatMetrics(entries = []) {
  const valid = e => Number.isFinite(e.hp) && Number.isFinite(e.max) && e.max > 0;
  const pooled = list => {
    const withHp = list.filter(valid);
    if (!withHp.length) return null;
    const max = withHp.reduce((n, e) => n + e.max, 0);
    const hp = withHp.reduce((n, e) => n + Math.max(0, Math.min(e.hp, e.max)), 0);
    return hp / max * 100;
  };
  const enemies = entries.filter(e => e.side === "enemy");
  const party = entries.filter(e => e.side === "party");
  const pcs = party.filter(e => e.pc && valid(e));
  const down = e => e.defeated || (valid(e) && e.hp <= 0);
  return {
    enemies: pooled(enemies),
    party: pooled(party),
    anyPc: pcs.length ? Math.min(...pcs.map(e => Math.max(0, e.hp) / e.max * 100)) : null,
    enemiesRemaining: enemies.length ? enemies.filter(e => !down(e)).length : null
  };
}

/**
 * Whole-fight thresholds crossed between two metric snapshots, skipping ones already fired.
 * Ordered by priority, then extremeness, so the last element is the one to play.
 */
export function crossedCombatRules(rules, previous, current, fired = new Set()) {
  if (!previous || !current) return [];
  const extremeness = r => directionOf(r) === "above" ? Number(r.threshold) : -Number(r.threshold);
  return (rules || []).filter(r => r.enabled !== false && sourceOf(r) !== "actor" && !fired.has(r.id) &&
    crosses(r, previous[sourceOf(r)], current[sourceOf(r)]))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || extremeness(a) - extremeness(b));
}

/** Short description of a threshold rule, e.g. "All enemies' HP % ≤ 50%". */
export function describeThreshold(rule) {
  const source = sourceOf(rule);
  const unit = isPercentSource(source) ? "%" : "";
  return `${THRESHOLD_SOURCES[source]} ${directionOf(rule) === "above" ? "≥" : "≤"} ${Number(rule.threshold)}${unit}`;
}
export function actorMatches(savedUuid, actor) {
  if (!savedUuid) return true;
  if (!actor) return false;
  const ids = [actor.uuid, actor.baseActor?.uuid, actor.token?.baseActor?.uuid,
    actor.token?.actor?.uuid, actor.id && `Actor.${actor.id}`, actor.parent?.actor?.uuid].filter(Boolean);
  return ids.includes(savedUuid);
}
export function profileMatches(profile, {actor, sceneId, combat} = {}) {
  if (!profile?.enabled) return false;
  if (profile.sceneId && profile.sceneId !== sceneId) return false;
  if (!profile.actorUuid) return true;
  if (actorMatches(profile.actorUuid, actor)) return true;
  if (!combat) return false;
  return [...(combat.combatants || [])].some(c => actorMatches(profile.actorUuid, c.actor));
}
export function dynamicMatches(trigger, event, context = {}) {
  if (!trigger?.enabled || trigger.event !== event) return false;
  if (trigger.actorUuid && !actorMatches(trigger.actorUuid, context.actor)) return false;
  if (trigger.sceneId && trigger.sceneId !== context.sceneId) return false;
  if (event === 'roundStart' && Number(trigger.round || 0) > 0 && Number(trigger.round) !== Number(context.round)) return false;
  if (event === 'spellCast' && trigger.match && !String(context.spell || '').toLowerCase().includes(String(trigger.match).toLowerCase())) return false;
  if ((event === 'conditionAdded' || event === 'conditionRemoved') && trigger.match && !String(context.condition || '').toLowerCase().includes(String(trigger.match).toLowerCase())) return false;
  return true;
}
export function shouldInterrupt(incoming, active, force = false) {
  return Boolean(force) || priority(incoming, 0) >= priority(active, 0);
}
export const CINEMATIC_ACTIONS = Object.freeze(['track','scene','journal','darkness','macro','pause','play','focus','message']);
export function sortedSteps(cue) {
  return (cue?.steps || []).map((step,index) => ({...step,index})).filter(step =>
    CINEMATIC_ACTIONS.includes(step.action) && Number.isFinite(Number(step.at)) && Number(step.at) >= 0 && Number(step.at) <= 7200)
    .sort((a,b) => Number(a.at) - Number(b.at) || a.index - b.index);
}
export function dueSteps(cue, seconds, played = new Set()) {
  return sortedSteps(cue).filter(step => Number(step.at) <= seconds && !played.has(step.id || step.index));
}
