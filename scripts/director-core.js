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
/** Highest-to-lowest threshold crossed when health falls. No repeat on healing. */
export function crossedPhases(phases, previous, current, fired = new Set()) {
  if (previous === null || current === null || !(current < previous)) return [];
  return (phases || []).filter(p => p.enabled !== false && Number(p.threshold) >= 0 && Number(p.threshold) <= 100 &&
    previous > Number(p.threshold) && current <= Number(p.threshold) && !fired.has(p.id))
    .sort((a, b) => Number(b.threshold) - Number(a.threshold));
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
