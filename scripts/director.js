import { MODULE_ID, serverNow } from './state.js';
import { raise, closeOnEscape, preserveScroll, confirmDialog } from './ui.js';
import { uid, escapeHtml as e, cleanString, hpPercent, crossedPhases, actorMatches, profileMatches, dynamicMatches, dueSteps, priority } from './director-core.js';
const SOCKET = `module.${MODULE_ID}`;
const EVENTS = {
  combatStart:'Combat begins', combatEnd:'Combat ends', initiative:'Initiative rolled', turnStart:'Creature turn begins',
  roundStart:'Round begins', defeated:'Creature defeated / 0 HP', spellCast:'Spell chat card created',
  conditionAdded:'Condition/effect added', conditionRemoved:'Condition/effect removed', scene:'Scene activated', manual:'Manual / macro'
};
const trackOptions = (tracks, selected = '') => '<option value="">Choose library track</option>' + tracks.map(t => `<option value="${e(t.id)}" ${t.id === selected ? 'selected':''}>${e(t.title)}</option>`).join('');
const sceneOptions = (selected = '') => '<option value="">Any / current scene</option>' + (game.scenes?.contents || []).map(s => `<option value="${e(s.id)}" ${selected === s.id ? 'selected':''}>${e(s.name)}</option>`).join('');
const actorOptions = (selected = '') => '<option value="">Any creature</option>' + (game.actors?.contents || []).map(a => `<option value="${e(a.uuid)}" ${selected === a.uuid ? 'selected':''}>${e(a.name)}</option>`).join('');
const cb = (name, checked, label) => `<label class="fwr-dir-inline"><input type="checkbox" name="${name}" ${checked ? 'checked':''}> ${label}</label>`;
const sel = (name, values, selected) => `<select name="${name}">${Object.entries(values).map(([key,label])=>`<option value="${e(key)}" ${key === selected?'selected':''}>${e(label)}</option>`).join('')}</select>`;
const num = (name, v, min=0, max=100) => `<input type="number" name="${name}" min="${min}" max="${max}" step="1" value="${e(v)}">`;

export class Director {
  constructor(watch) {
    this.watch=watch; this.dialog=null; this.profileId=''; this.cueId=''; this.actorHint='';
    this.previousHP=new Map(); this.phaseFired=new Set(); this.dynamicFired=new Set(); this.timelineFired=new Set();
    this.currentTimeline=''; this.timer=null;
  }
  get profiles() { return game.settings.get(MODULE_ID,'encounterProfiles') || []; }
  get cues() { return game.settings.get(MODULE_ID,'cinematicCues') || []; }
  get library() { return this.watch.music.library; }
  get activeCombat() { return game.combats?.active || game.combat || (game.combats || []).find(c => c.started); }
  remember(actor) { const value=hpPercent(actor); if(actor?.uuid && value !== null) this.previousHP.set(actor.uuid,value); }
  start() {
    for(const a of game.actors?.contents || []) this.remember(a);
    for(const combat of game.combats || []) for(const c of combat.combatants || []) this.remember(c.actor);
    Hooks.on('createCombatant', c => this.remember(c.actor));
    Hooks.on('updateToken',(token,changes) => {
      if (!this.watch.isLeader || !token?.actor) return;
      if (changes.delta?.system?.attributes?.hp?.value !== undefined || changes.actorData?.system?.attributes?.hp?.value !== undefined)
        this.handleHP(token.actor);
    });
    Hooks.on('updateActor',(actor,changes) => {
      if (!this.watch.isLeader || changes?.system?.attributes?.hp?.value === undefined) return;
      this.handleHP(actor);
    });
    Hooks.on('updateCombat',(combat, changes) => {
      if (!this.watch.isLeader) return;
      const ctx={combat,sceneId:combat.scene?.id || game.scenes?.active?.id};
      if (Object.hasOwn(changes,'round') && combat.round >= 1) {
        this.fire('roundStart',{...ctx,round:combat.round,key:`${combat.id}:round:${combat.round}`});
        if (combat.round === 1) this.fire('combatStart',{...ctx,key:`${combat.id}:start`});
      }
      // A new round can leave `turn` unchanged (e.g. one combatant), so treat it as a turn start too.
      if ((Object.hasOwn(changes,'turn') || Object.hasOwn(changes,'round')) && combat.round >= 1 && combat.combatant)
        this.fire('turnStart',{...ctx,actor:combat.combatant.actor,key:`${combat.id}:r${combat.round}:t${combat.turn}`});
      if (changes.active === false) this.fire('combatEnd',{...ctx,key:`${combat.id}:end`});
    });
    Hooks.on('updateCombatant',(c,change)=>{
      if (!this.watch.isLeader) return;
      const ctx={actor:c.actor,combat:c.parent,sceneId:c.parent?.scene?.id || game.scenes?.active?.id};
      if (Object.hasOwn(change,'initiative') && Number.isFinite(c.initiative)) this.fire('initiative',{...ctx,key:`${c.parent?.id}:${c.id}:initiative:${c.initiative}`});
      if ((change.defeated === true || change.isDefeated === true) && c.isDefeated)
        this.fire('defeated',{...ctx,key:`${c.parent?.id}:${c.actor?.uuid || c.id}:defeated`});
    });
    Hooks.on('deleteCombat',(combat)=>{
      this.fire('combatEnd',{combat,key:`${combat.id}:end`});
      for (const set of [this.phaseFired,this.dynamicFired]) for(const k of set) if(k.startsWith(`${combat.id}:`)) set.delete(k);
    });
    Hooks.on('createActiveEffect', effect => this.effect('conditionAdded',effect));
    Hooks.on('deleteActiveEffect', effect => this.effect('conditionRemoved',effect));
    Hooks.on('createChatMessage', message => this.spellMessage(message));
    Hooks.on('updateScene',(scene,change) => { if(change.active === true) this.fire('scene',{sceneId:scene.id,key:`scene:${scene.id}:${Date.now()}`}); });
    this.timer=setInterval(() => { this.tick().catch(err => console.error(`${MODULE_ID} director`,err)); }, 500);
  }
  effect(event,effect) {
    if(!this.watch.isLeader) return;
    const actor=effect.parent?.documentName === 'Actor' ? effect.parent : null;
    if(!actor) return;
    const condition=effect.statuses?.size ? [...effect.statuses].join(', ') : effect.name || effect.label || '';
    this.fire(event,{actor,condition,combat:this.activeCombat,key:`${effect.uuid}:${event}`});
  }
  spellMessage(message) {
    if(!this.watch.isLeader || !message) return;
    // Deliberately requires a D&D-system spell activity flag; ordinary chat never activates spells.
    const f=message.flags?.dnd5e || {};
    const type=String(f?.roll?.type || f?.item?.type || f?.itemData?.type || message.system?.item?.type || '').toLowerCase();
    const uuid=f?.item?.uuid || f?.itemUuid || f?.item?.id || '';
    if(type !== 'spell' && !f?.spell && !f?.isSpell && !String(uuid).toLowerCase().includes('spell')) return;
    const speaker=message.speaker;
    const actor=(speaker?.actor && game.actors.get(speaker.actor)) || null;
    const spell=cleanString(f?.item?.name || f?.itemData?.name || f?.spell?.name || message?.system?.item?.name || message?.subject?.name || '',120);
    this.fire('spellCast',{actor,spell,combat:this.activeCombat,key:`spell:${message.id}`});
  }
  handleHP(actor) {
    const current=hpPercent(actor);
    const previous=this.previousHP.get(actor?.uuid);
    this.remember(actor);
    if(current === null || previous === undefined || current >= previous) return;
    const combat=(game.combats || []).find(c => c.started && [...(c.combatants || [])].some(x => actorMatches(actor.uuid,x.actor))) || this.activeCombat;
    if(!combat?.started || ![...(combat.combatants || [])].some(c => actorMatches(actor.uuid,c.actor))) return;
    const ctx={actor,combat,sceneId:combat.scene?.id || game.scenes?.active?.id};
    for(const profile of this.profiles) {
      // HP phases belong to the profile's boss. Without one they'd fire for every goblin and PC in the fight.
      if (!profile.actorUuid || !profileMatches(profile,ctx) || !actorMatches(profile.actorUuid,actor)) continue;
      const prefix=`${combat.id}:${profile.id}:${actor.uuid}:`;
      const fired=new Set([...this.phaseFired].filter(x=>x.startsWith(prefix)).map(x=>x.slice(prefix.length)));
      const matched=crossedPhases(profile.phases,previous,current,fired);
      if(!matched.length) continue;
      for(const phase of matched) this.phaseFired.add(prefix + phase.id);
      // A single huge hit may cross multiple thresholds. Play the deepest reached phase, not 3 consecutive interrupts.
      const deepest=matched[matched.length-1];
      this.playRule(deepest,profile.priority,`${profile.name}: ${deepest.name || `${deepest.threshold}% HP`}`);
    }
    // Same key as the combatant "defeated" toggle, so dropping to 0 HP and being marked defeated fire once.
    if(previous > 0 && current <= 0) this.fire('defeated',{...ctx,key:`${combat.id}:${actor.uuid}:defeated`});
  }
  fire(event,context={}) {
    if(!this.watch.isLeader) return false;
    const ctx={...context,sceneId:context.sceneId || game.scenes?.active?.id,combat:context.combat || this.activeCombat};
    let triggered=false;
    for(const profile of this.profiles) {
      if(!profileMatches(profile,ctx)) continue;
      for(const trigger of profile.triggers || []) {
        if(!dynamicMatches(trigger,event,ctx)) continue;
        const key=`${ctx.combat?.id || 'world'}:${profile.id}:${trigger.id}:${ctx.key || uid()}`;
        if(this.dynamicFired.has(key)) continue;
        if(trigger.once && [...this.dynamicFired].some(k=>k.startsWith(`${ctx.combat?.id || 'world'}:${profile.id}:${trigger.id}:`))) continue;
        this.dynamicFired.add(key);
        if(this.dynamicFired.size > 3000) this.dynamicFired.delete(this.dynamicFired.values().next().value);
        triggered=this.playRule(trigger,profile.priority,`${profile.name}: ${trigger.name}`) || triggered;
      }
    }
    return triggered;
  }
  playRule(rule, base=50, reason='Cue', manualTest=false) {
    const track=this.library.find(t=>t.id === rule.libraryId);
    if(!track) { console.warn(`${MODULE_ID}: missing track for ${reason}`); return false; }
    this.watch.issue('TRIGGER',{url:track.url,title:track.title,loop:rule.loop ?? track.loop,
      action:rule.action === 'queue'?'queue':'interrupt',resume:Boolean(rule.resume),
      priority:priority(rule.priority,priority(base)),force:Boolean(rule.force),quiet:!manualTest});
    return true;
  }
  manual(profileId, triggerId) {
    if(!game.user?.isGM) return false;
    const profile=this.profiles.find(p=>p.id===profileId);
    const rule=profile?.triggers?.find(t=>t.id===triggerId && t.event==='manual' && t.enabled);
    if(!rule) return false;
    return this.playRule(rule,profile.priority);
  }
  async saveProfiles(profiles) { if(!game.user.isGM) return; await game.settings.set(MODULE_ID,'encounterProfiles',profiles.slice(0,100)); this.render(); }
  async saveCues(cues) { if(!game.user.isGM) return; await game.settings.set(MODULE_ID,'cinematicCues',cues.slice(0,100)); this.render(); }
  runCue(identifier) {
    if(!game.user.isGM) return false;
    const cue=this.cues.find(c=>c.id===identifier || c.name===identifier);
    if(!cue) return false;
    this.watch.issue('DIRECTOR_START',{cueId:cue.id,title:cue.name,focus:cue.focus});
    return true;
  }
  stopCue() { if(game.user.isGM) this.watch.issue('DIRECTOR_STOP'); }
  async tick() {
    if(!this.watch.isLeader) return;
    const active=this.watch.state.cinematic;
    if(!active) { this.currentTimeline='';this.timelineFired.clear();return; }
    const key=`${this.watch.state.roomId}:${active.cueId}:${active.startedAt}`;
    if(key!==this.currentTimeline) {this.currentTimeline=key;this.timelineFired.clear();}
    const cue=this.cues.find(c=>c.id===active.cueId);
    if(!cue) {
      // The running cinematic was deleted; end it so focus mode doesn't stay on forever.
      if(this.stoppingMissing!==key) {this.stoppingMissing=key;this.watch.issue('DIRECTOR_STOP',{quiet:true});}
      return;
    }
    const elapsed=Math.max(0,(serverNow()-active.startedAt)/1000);
    for(const step of dueSteps(cue,elapsed,this.timelineFired)) {
      const sid=step.id || step.index;
      this.timelineFired.add(sid);
      // Avoid replaying stale effects after a GM disconnect/reconnect.
      if(elapsed - Number(step.at) > 10) continue;
      await this.executeStep(step);
    }
  }
  async executeStep(step) {
    if(!this.watch.isLeader) return;
    try {
      switch(step.action) {
        case 'track': {
          const track=this.library.find(t=>t.id===step.refId);
          if(track) this.watch.issue('TRIGGER',{url:track.url,title:track.title,loop:track.loop,
            action:step.mode==='queue'?'queue':'interrupt',resume:Boolean(step.resume),priority:priority(step.priority,90),quiet:true});
          break;
        }
        case 'scene': {
          const scene=game.scenes?.get(step.refId);
          if(scene) await scene.activate();
          break;
        }
        case 'darkness': {
          const scene=game.scenes?.active;
          if(scene) await scene.update({'environment.darknessLevel':Math.min(1,Math.max(0,Number(step.value)||0))});
          break;
        }
        case 'journal': this.watch.broadcastJournal(step.refId); break;
        case 'macro': {
          const macro=game.macros?.get(step.refId);
          if(macro && game.user.isGM) await macro.execute();
          break;
        }
        case 'focus': this.watch.issue('DIRECTOR_FOCUS',{enabled:step.value !== 'off',quiet:true}); break;
        case 'pause': this.watch.issue('PAUSE',{quiet:true}); break;
        case 'play': this.watch.issue('PLAY',{quiet:true}); break;
        case 'message': {
          const content=e(cleanString(step.message,500));
          if(content) await ChatMessage.create({content:`<p><strong>Director cue:</strong> ${content}</p>`,speaker:{alias:'Watch Room'}});
          break;
        }
      }
    } catch(error) {ui.notifications?.warn(`Director cue failed: ${error.message}`);console.warn(error);}
  }
  showJournal(journalId) {
    const doc=game.journal?.get(journalId);
    if(!doc) return;
    if(!doc.testUserPermission?.(game.user,'OBSERVER') && !game.user.isGM) return;
    doc.sheet?.render(true);
  }
  open(actorUuid='') {
    if(!game.user.isGM) {ui.notifications?.warn('Cinematic Director is GM-only.'); return;}
    if(actorUuid) this.actorHint=actorUuid;
    if(!this.dialog) {
      const el=document.createElement('section');el.id='fwr-director';el.className='fwr-director';el.hidden=true;
      el.setAttribute('role','dialog');el.setAttribute('aria-label','Encounter and Cinematic Director');
      el.addEventListener('click',ev=>this.onClick(ev));
      el.addEventListener('submit',ev=>this.onSubmit(ev));
      el.addEventListener('pointerdown',()=>raise(el));
      closeOnEscape(el,()=>{el.hidden=true;});
      document.body.append(el);this.dialog=el;
    }
    this.dialog.hidden=false;raise(this.dialog);this.render();
    this.dialog.querySelector('[data-close]')?.focus();
  }
  render() {
    if(!this.dialog || this.dialog.hidden) return;
    preserveScroll(this.dialog,['.fwr-dir-scroller'],()=>this.renderHTML());
  }
  renderHTML() {
    const running=this.watch.state.cinematic;
    const profiles=this.profiles; const cues=this.cues;
    const p=profiles.find(x=>x.id===this.profileId); const cue=cues.find(x=>x.id===this.cueId);
    const tracks=this.library;
    this.dialog.innerHTML=`<div class="fwr-dir-window"><header><h2>⚜ Encounter & Cinematic Director</h2><button type="button" data-close aria-label="Close Director">✕</button></header>
      <div class="fwr-dir-scroller"><div class="fwr-dir-nav"><button data-op="library">♫ Music Library</button><button data-op="new-profile">+ Encounter profile</button><button data-op="new-cue">+ Cinematic</button><button data-op="stop-cue" ${running?'':'disabled'}>■ Stop cinematic</button>${running?`<span class="fwr-dir-running" role="status">▶ Running: ${e(running.title || 'cinematic')}</span>`:''}</div>
      <div class="fwr-dir-columns"><section><h3>Encounter Profiles <small>${profiles.length}</small></h3>
      <div class="fwr-dir-list">${profiles.map(x=>`<div class="fwr-dir-item ${this.profileId===x.id?'selected':''}"><button data-op="select-profile" data-id="${e(x.id)}">${e(x.name)}</button><small>${x.enabled?'Enabled':'Disabled'} · Priority ${e(x.priority)}</small><button data-op="toggle-profile" data-id="${e(x.id)}">${x.enabled?'Pause':'Enable'}</button></div>`).join('') || '<p>Create a profile for your first encounter.</p>'}</div>
      <h3>Cinematics <small>${cues.length}</small></h3><div class="fwr-dir-list">${cues.map(x=>`<div class="fwr-dir-item ${this.cueId===x.id?'selected':''} ${running?.cueId===x.id?'running':''}"><button data-op="select-cue" data-id="${e(x.id)}">${e(x.name)}</button><small>${x.steps?.length||0} steps${running?.cueId===x.id?' · running':''}</small><button data-op="run-cue" data-id="${e(x.id)}">▶ Play</button></div>`).join('') || '<p>Save a timed cinematic cue.</p>'}</div>
      </section><section class="fwr-dir-editor">
      ${p?this.profileEditor(p):'<h3>Encounter editor</h3><p>Select a profile or create one. Attach a profile to a world actor or scene to reuse it.</p>'}
      ${cue?this.cueEditor(cue):'<h3>Cinematic editor</h3><p>Select a cinematic to edit its synchronized cue timeline.</p>'}
      </section></div>
      <p class="fwr-dir-tip">Automation runs on the active GM client. Phase thresholds fire once per encounter; cinematic timelines are shared across the room. Music stays in the Music Library and cues reference tracks by ID.</p>
      </div></div>`;
  }
  profileEditor(p) {
    return `<h3>Boss phases & dynamic triggers · ${e(p.name)}</h3>
      <form data-form="profile" class="fwr-dir-form"><input type="hidden" name="id" value="${e(p.id)}">
      <label>Name<input name="name" maxlength="100" required value="${e(p.name)}"></label>
      <label>Boss / actor<select name="actorUuid">${actorOptions(p.actorUuid)}</select></label>
      <label>Scene restriction<select name="sceneId">${sceneOptions(p.sceneId)}</select></label>
      <label>Base priority (0–100)${num('priority',p.priority)}</label>
      ${cb('enabled',p.enabled,'Enabled')}
      <button type="submit">Save profile</button><button type="button" data-op="delete-profile" data-id="${e(p.id)}" class="fwr-dir-danger">Delete</button></form>
      <h4>Boss HP phases</h4>${p.actorUuid?'':'<p class="fwr-dir-warn">Choose a boss actor above and save the profile. HP phases only run for that actor.</p>'}<div class="fwr-dir-list">${(p.phases||[]).map(x=>`<div class="fwr-dir-item"><strong>${e(x.threshold)}% · ${e(x.name||'Phase')}</strong><small>${e(this.library.find(t=>t.id===x.libraryId)?.title || '(Missing track)')} · Priority ${e(x.priority)} · ${x.action||'interrupt'}</small><button data-op="phase-test" data-id="${e(x.id)}" data-parent="${e(p.id)}">▶</button><button data-op="phase-edit" data-id="${e(x.id)}" data-parent="${e(p.id)}">Edit</button><button data-op="phase-delete" data-id="${e(x.id)}" data-parent="${e(p.id)}">✕</button></div>`).join('')||'<p>No phases configured.</p>'}</div>
      <form data-form="phase" class="fwr-dir-form"><input type="hidden" name="parent" value="${e(p.id)}"><input type="hidden" name="editId" value=""><label>Phase label<input name="name" placeholder="Enraged" maxlength="80"></label>
      <label>Trigger at HP ≤ %${num('threshold',50)}</label><label>Track<select name="libraryId" required>${trackOptions(this.library)}</select></label>
      <label>Priority${num('priority',75)}</label><label>Playback${sel('action',{interrupt:'Interrupt',queue:'Queue'},'interrupt')}</label>
      ${cb('loop',true,'Loop this phase')} ${cb('resume',false,'Resume previous track')}<button type="submit">Save HP phase</button><button type="button" data-op="phase-preset" data-parent="${e(p.id)}" title="Use track currently selected in this HP phase form for all three thresholds">Preset 75 / 50 / 25%</button></form>
      <h4>Dynamic triggers</h4><div class="fwr-dir-list">${(p.triggers||[]).map(x=>`<div class="fwr-dir-item"><strong>${e(x.name)}</strong><small>${e(EVENTS[x.event]||x.event)}${x.match?' · '+e(x.match):''} · P${e(x.priority)}</small><button data-op="trigger-test" data-id="${e(x.id)}" data-parent="${e(p.id)}">▶</button><button data-op="trigger-edit" data-id="${e(x.id)}" data-parent="${e(p.id)}">Edit</button><button data-op="trigger-delete" data-id="${e(x.id)}" data-parent="${e(p.id)}">✕</button></div>`).join('')||'<p>No dynamic triggers yet.</p>'}</div>
      <form data-form="trigger" class="fwr-dir-form"><input type="hidden" name="parent" value="${e(p.id)}"><input type="hidden" name="editId" value="">
      <label>Name<input name="name" required maxlength="100" placeholder="Lich casts Power Word Kill"></label>
      <label>Event${sel('event',EVENTS,'roundStart')}</label>
      <label>Match spell/condition (optional)<input name="match" maxlength="120" placeholder="fireball / poisoned"></label>
      <label>Only on round (0 = any)${num('round',0,0,999)}</label>
      <label>Actor filter<select name="actorUuid">${actorOptions()}</select></label>
      <label>Track<select name="libraryId" required>${trackOptions(this.library)}</select></label>
      <label>Priority${num('priority',60)}</label>
      <label>Playback${sel('action',{interrupt:'Interrupt',queue:'Queue'},'interrupt')}</label>
      ${cb('once',true,'Once per combat')}${cb('resume',true,'Resume previous')}${cb('loop',false,'Loop')}
      <button type="submit">Save dynamic trigger</button></form>`;
  }
  cueEditor(c) {
    const names={track:'Play library track',scene:'Activate Foundry scene',journal:'Show journal',darkness:'Set scene darkness',macro:'Execute GM macro',pause:'Pause media',play:'Resume media',focus:'Player focus on/off',message:'Send narration to chat'};
    return `<h3>Cinematic timeline · ${e(c.name)}</h3><form data-form="cue" class="fwr-dir-form"><input type="hidden" name="id" value="${e(c.id)}"><label>Name<input name="name" maxlength="100" required value="${e(c.name)}"></label>${cb('focus',c.focus,'Start with player focus mode')}
      <button type="submit">Save cinematic</button><button type="button" data-op="run-cue" data-id="${e(c.id)}">▶ Run</button><button type="button" data-op="delete-cue" data-id="${e(c.id)}" class="fwr-dir-danger">Delete</button></form>
      <div class="fwr-dir-list">${[...(c.steps||[])].sort((a,b)=>a.at-b.at).map(step=>`<div class="fwr-dir-item"><strong>${e(step.at)}s · ${e(names[step.action]||step.action)}</strong><small>${e(this.library.find(t=>t.id===step.refId)?.title || game.scenes?.get(step.refId)?.name || game.journal?.get(step.refId)?.name || step.message || step.value || '')}</small><button data-op="step-edit" data-parent="${e(c.id)}" data-id="${e(step.id)}">Edit</button><button data-op="step-delete" data-parent="${e(c.id)}" data-id="${e(step.id)}">✕</button></div>`).join('')||'<p>No timeline steps saved.</p>'}</div>
      <form data-form="step" class="fwr-dir-form"><input type="hidden" name="parent" value="${e(c.id)}"><input type="hidden" name="editId" value=""><label>At seconds${num('at',0,0,7200)}</label><label>Action${sel('action',names,'track')}</label>
      <label>Library track<select name="trackId">${trackOptions(this.library)}</select></label>
      <label>Scene<select name="sceneId">${sceneOptions()}</select></label>
      <label>Journal<select name="journalId"><option value="">Choose journal</option>${(game.journal?.contents||[]).map(j=>`<option value="${e(j.id)}">${e(j.name)}</option>`).join('')}</select></label>
      <label>Macro<select name="macroId"><option value="">Choose macro</option>${(game.macros?.contents||[]).map(m=>`<option value="${e(m.id)}">${e(m.name)}</option>`).join('')}</select></label>
      <label>Value (darkness 0–1, focus on/off)<input name="value" maxlength="30" placeholder="on / off / 0.8"></label>
      <label>Chat narration<input name="message" maxlength="500" placeholder="The portal opens..."></label>
      <label>Track priority${num('priority',90)}</label><label>Track mode${sel('mode',{interrupt:'Play now',queue:'Queue'},'interrupt')}</label>
      ${cb('resume',false,'Resume prior track')}<button type="submit">Save timeline step</button></form>`;
  }
  async onClick(ev) {
    const b=ev.target.closest('button');if(!b) return;
    if(b.hasAttribute('data-close')) {this.dialog.hidden=true;return;}
    const op=b.dataset.op, key=b.dataset.id, parent=b.dataset.parent;
    if(op==='library') {this.watch.music.openManager();return;}
    if(op==='new-profile') {
      const p={id:uid(),name:'New Encounter',enabled:true,actorUuid:this.actorHint,sceneId:'',priority:60,phases:[],triggers:[]};
      this.profileId=p.id;this.cueId='';return this.saveProfiles([...this.profiles,p]);
    }
    if(op==='new-cue') {const c={id:uid(),name:'New Cinematic',focus:true,steps:[]};this.cueId=c.id;this.profileId='';return this.saveCues([...this.cues,c]);}
    if(op==='select-profile') {this.profileId=key;this.cueId='';return this.render();}
    if(op==='select-cue') {this.cueId=key;this.profileId='';return this.render();}
    if(op==='toggle-profile') return this.saveProfiles(this.profiles.map(p=>p.id===key?{...p,enabled:!p.enabled}:p));
    if(op==='run-cue') return this.runCue(key);
    if(op==='stop-cue') return this.stopCue();
    if(op==='delete-profile') {
      if(!(await confirmDialog('Delete encounter profile?','Its HP phases and dynamic triggers will be removed.'))) return;
      this.profileId='';return this.saveProfiles(this.profiles.filter(p=>p.id!==key));
    }
    if(op==='delete-cue') {
      if(!(await confirmDialog('Delete cinematic?','Its timeline steps will be removed.'))) return;
      if(this.watch.state.cinematic?.cueId===key) this.stopCue();
      this.cueId='';return this.saveCues(this.cues.filter(c=>c.id!==key));
    }
    if(op==='phase-preset') {
      const form=this.dialog.querySelector('[data-form="phase"]');
      const trackId=form?.elements.libraryId.value;
      if(!this.library.some(t=>t.id===trackId)) {ui.notifications?.warn('Select a library track in the HP phase form first.');return;}
      const preset=[75,50,25].map((n,i)=>({id:uid(),name:`Phase ${n}%`,enabled:true,threshold:n,libraryId:trackId,priority:75+i*5,action:'interrupt',resume:false,loop:true}));
      return this.saveProfiles(this.profiles.map(p=>p.id===parent?{...p,phases:[...(p.phases||[]),...preset]}:p));
    }
    if(['phase-edit','trigger-edit','step-edit'].includes(op)) {
      const p=this.profiles.find(x=>x.id===parent),c=this.cues.find(x=>x.id===parent);
      const kind=op.split('-')[0];
      const entity=kind==='phase'?p?.phases?.find(x=>x.id===key):kind==='trigger'?p?.triggers?.find(x=>x.id===key):c?.steps?.find(x=>x.id===key);
      const form=this.dialog.querySelector(`[data-form="${kind}"]`);
      if(!entity || !form) return;
      form.elements.editId.value=entity.id;
      for(const [field,value] of Object.entries(entity)) {
        const input=form.elements[field];
        if(!input) continue;
        if(input.type==='checkbox') input.checked=Boolean(value);
        else if (typeof value==='string' || typeof value==='number') input.value=value;
      }
      if(kind==='step') {
        const refField={track:'trackId',scene:'sceneId',journal:'journalId',macro:'macroId'}[entity.action];
        if(refField) form.elements[refField].value=entity.refId||'';
      }
      const submit=form.querySelector('button[type="submit"]');
      if(submit) submit.textContent=`Update ${kind==='step'?'timeline step':kind==='phase'?'HP phase':'dynamic trigger'}`;
      form.classList.add('fwr-dir-editing');
      form.scrollIntoView({block:'center',behavior:'smooth'});
      form.querySelector('input[name="name"]')?.focus();return;
    }
    if(op==='phase-test' || op==='trigger-test') {
      const p=this.profiles.find(x=>x.id===parent);
      const rule=(op==='phase-test'?p?.phases:p?.triggers)?.find(x=>x.id===key);
      if(rule) this.playRule(rule,p.priority,'Test',true);return;
    }
    if(op==='phase-delete' || op==='trigger-delete') {
      const prop=op==='phase-delete'?'phases':'triggers';
      return this.saveProfiles(this.profiles.map(p=>p.id===parent?{...p,[prop]:(p[prop]||[]).filter(x=>x.id!==key)}:p));
    }
    if(op==='step-delete') return this.saveCues(this.cues.map(c=>c.id===parent?{...c,steps:(c.steps||[]).filter(x=>x.id!==key)}:c));
  }
  async onSubmit(ev) {
    const form=ev.target;if(!form.matches('form[data-form]')) return;
    ev.preventDefault();if(!game.user.isGM) return;
    const data=Object.fromEntries(new FormData(form));
    const chk=n=>data[n]==='on';
    try {
      if(data.name && !cleanString(data.name)) throw new Error('Name is required.');
      if(form.dataset.form==='profile') return await this.saveProfiles(this.profiles.map(p=>p.id===data.id?{
        ...p,name:cleanString(data.name,100),actorUuid:data.actorUuid||'',sceneId:data.sceneId||'',priority:priority(data.priority,60),enabled:chk('enabled')}:p));
      if(form.dataset.form==='phase' || form.dataset.form==='trigger') {
        if(!this.library.some(x=>x.id===data.libraryId)) throw new Error('Choose a saved library track first.');
        const prop=form.dataset.form==='phase'?'phases':'triggers';
        const threshold=Math.max(0,Math.min(100,Number(data.threshold)||0));
        const entry={id:data.editId||uid(),name:cleanString(data.name || `Phase ${threshold}%`,100),libraryId:data.libraryId,
          priority:priority(data.priority,60),action:data.action==='queue'?'queue':'interrupt',resume:chk('resume'),loop:chk('loop'),enabled:true};
        if(prop==='phases') entry.threshold=threshold;
        else Object.assign(entry,{event:data.event,match:cleanString(data.match,120),round:Math.max(0,Math.floor(Number(data.round)||0)),actorUuid:data.actorUuid||'',once:chk('once')});
        return await this.saveProfiles(this.profiles.map(p=>p.id===data.parent?{...p,[prop]:(data.editId ? (p[prop]||[]).map(x=>x.id===data.editId?entry:x) : [...(p[prop]||[]),entry]).slice(0,100)}:p));
      }
      if(form.dataset.form==='cue') return await this.saveCues(this.cues.map(c=>c.id===data.id?{...c,name:cleanString(data.name,100),focus:chk('focus')}:c));
      if(form.dataset.form==='step') {
        const at=Number(data.at);if(!Number.isFinite(at)||at<0||at>7200) throw new Error('Enter a time between 0 and 7200 seconds.');
        const action=data.action;
        const kinds={track:data.trackId,scene:data.sceneId,journal:data.journalId,macro:data.macroId};
        const refId=kinds[action] || '';
        if(Object.hasOwn(kinds,action) && !refId) throw new Error(`Choose a ${action} first.`);
        const entry={id:data.editId||uid(),at,action,refId,value:cleanString(data.value,30),message:cleanString(data.message,500),priority:priority(data.priority,90),mode:data.mode,resume:chk('resume')};
        return await this.saveCues(this.cues.map(c=>c.id===data.parent?{...c,steps:(data.editId ? (c.steps||[]).map(x=>x.id===data.editId?entry:x) : [...(c.steps||[]),entry]).slice(0,100)}:c));
      }
    } catch(error) {ui.notifications?.error(error.message);}
  }
}
