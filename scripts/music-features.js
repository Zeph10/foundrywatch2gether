import { MODULE_ID, parseSource } from './state.js';
import { raise, closeOnEscape, preserveScroll, confirmDialog } from './ui.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const events = {
  initiative:'Creature rolls initiative',combatStart:'Combat starts',combatEnd:'Combat ends',
  turnStart:'Creature starts turn',defeated:'Creature reaches 0 HP / is defeated',scene:'Scene becomes active',manual:'Manual / macro'
};
const requireActor = new Set(['initiative','turnStart','defeated']);
const allowAudio = /\.(mp3|ogg|opus|wav|m4a|aac|flac)$/i;
const getNode = html => html instanceof HTMLElement ? html : html?.[0] instanceof HTMLElement ? html[0] : null;
const has = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);

export class MusicFeatures {
  constructor(watch) { this.watch = watch; this.dialog = null; this.seen = new Set(); this.actorHint = ''; this.hpCache = new Map(); }
  get library() { return game.settings.get(MODULE_ID, 'musicLibrary') || []; }
  get triggers() { return game.settings.get(MODULE_ID, 'musicTriggers') || []; }
  rememberHP(actor) {
    if (actor?.uuid && Number.isFinite(Number(actor.system?.attributes?.hp?.value)))
      this.hpCache.set(actor.uuid, Number(actor.system.attributes.hp.value));
  }
  start() {
    for (const actor of game.actors?.contents || []) this.rememberHP(actor);
    for (const combat of game.combats || []) for (const combattant of combat.combatants || []) this.rememberHP(combattant.actor);
    Hooks.on('createCombatant', combatant => this.rememberHP(combatant.actor));
    Hooks.on('updateCombatant', (combatant, changes) => {
      if (!this.watch.isLeader) return;
      if (has(changes, 'initiative') && Number.isFinite(combatant.initiative))
        this.fire('initiative', {actor:combatant.actor, key:`${combatant.parent?.id}:${combatant.id}:initiative:${combatant.initiative}`});
      if ((changes.defeated === true || changes.isDefeated === true) && combatant.isDefeated)
        this.fire('defeated', {actor:combatant.actor, key:`${combatant.parent?.id}:${combatant.id}:down`});
    });
    Hooks.on('updateCombat', (combat, changes) => {
      if (!this.watch.isLeader) return;
      if (has(changes, 'round') && combat.round === 1) this.fire('combatStart', {key:`${combat.id}:start`});
      if (changes.active === false) this.fire('combatEnd', {key:`${combat.id}:end`});
      if (has(changes, 'turn') && combat.round >= 1 && combat.combatant)
        this.fire('turnStart', {actor:combat.combatant.actor, key:`${combat.id}:${combat.round}:${combat.turn}:${combat.combatant.id}`});
    });
    Hooks.on('deleteCombat', combat => this.fire('combatEnd', {key:`${combat.id}:end`}));
    Hooks.on('updateScene', (scene, change) => {
      if (change.active === true) this.fire('scene', {sceneId:scene.id, key:`scene:${scene.id}:${Date.now()}`});
    });
    // HP and defeated-condition changes are two independent signals; dedupe by combatant.
    Hooks.on('preUpdateActor', (actor, changes) => {
      if (!this.watch.isLeader) return;
      if (changes?.system?.attributes?.hp?.value !== undefined) this.rememberHP(actor);
    });
    Hooks.on('updateActor', (actor, changes) => {
      if (!this.watch.isLeader || changes?.system?.attributes?.hp?.value === undefined) return;
      const previous = this.hpCache.get(actor.uuid);
      const current = Number(actor.system?.attributes?.hp?.value);
      this.rememberHP(actor);
      if (!(previous > 0 && current <= 0)) return;
      for (const combat of game.combats || []) {
        const combatant = combat.combatants?.find(c => c.actor?.uuid === actor.uuid || c.actor?.id === actor.id);
        if (combatant) this.fire('defeated', {actor,key:`${combat.id}:${combatant.id}:down`});
      }
    });
    // V1 and V2 actor sheets: add one convenient "Music" header button for GMs.
    for (const hook of ['renderActorSheet', 'renderActorSheetV2', 'renderApplicationV2']) {
      Hooks.on(hook, (app, html) => {
        if (!game.user.isGM) return;
        const actor = app.actor || app.document;
        if (actor?.documentName !== 'Actor') return;
        const root = getNode(html) || getNode(app.element);
        const header = root?.querySelector('.window-header');
        if (!header || header.querySelector('.fwr-actor-button')) return;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'fwr-actor-button';
        button.title = 'Configure Watch Room music triggers for this actor';
        button.innerHTML = '<i class="fa-solid fa-music"></i> Music';
        button.addEventListener('click', e => {e.preventDefault(); e.stopPropagation(); this.openManager(actor.uuid);});
        header.append(button);
        if (!header.querySelector('.fwr-director-actor-button')) {
          const directorButton=document.createElement('button');
          directorButton.type='button';directorButton.className='fwr-actor-button fwr-director-actor-button';
          directorButton.title='Encounter profiles, phases, and cinematic cues';
          directorButton.innerHTML='<i class="fa-solid fa-wand-magic-sparkles"></i> Director';
          directorButton.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();this.watch.director.open(actor.uuid);});
          header.append(directorButton);
        }
      });
    }
  }
  matchesActor(rule, actor) {
    if (!rule.actorUuid) return true;
    if (!actor) return false;
    const candidates = [actor.uuid, `Actor.${actor.id}`, actor.baseActor?.uuid,
      actor.token?.baseActor?.uuid, actor.token?.actor?.uuid].filter(Boolean);
    return candidates.includes(rule.actorUuid);
  }
  fire(event, {actor = null, sceneId = '', key = ''} = {}) {
    if (!this.watch.isLeader) return;
    for (const rule of this.triggers) {
      if (!rule.enabled || rule.event !== event || !this.matchesActor(rule, actor)) continue;
      if (rule.sceneId && rule.sceneId !== (sceneId || game.scenes.active?.id)) continue;
      const tag = `${rule.id}:${key || id()}`;
      if (this.seen.has(tag)) continue;
      this.seen.add(tag);
      if (this.seen.size > 600) this.seen.delete(this.seen.values().next().value);
      this.run(rule);
    }
  }
  run(rule) {
    const track = this.library.find(x => x.id === rule.libraryId);
    if (!track) return false;
    this.watch.issue('TRIGGER', {url:track.url, title:track.title, loop:track.loop,
      action:rule.action === 'queue' ? 'queue':'interrupt', resume:Boolean(rule.resume),priority:Number(rule.priority ?? 50),quiet:true});
    return true;
  }
  manual(identifier) {
    if (!this.watch.canControl && !game.user.isGM) {ui.notifications?.warn('Only the GM or controllers may run manual music triggers.'); return false;}
    const rule = this.triggers.find(x => x.id === identifier || (x.event === 'manual' && x.name === identifier));
    if (!rule || !rule.enabled || rule.event !== 'manual') return false;
    this.watch.issue('RUN_TRIGGER', {triggerId:rule.id});
    return true;
  }
  async upload(file) {
    if (!game.user.isGM) throw new Error('Only GMs can upload and save tracks.');
    const ext = file?.name?.split('.').pop()?.toLowerCase();
    if (!ext || !allowAudio.test(`test.${ext}`)) throw new Error('Choose an MP3, OGG, OPUS, WAV, M4A, AAC or FLAC file.');
    if (file.size > 100 * 1024 * 1024) throw new Error('Audio uploads are limited to 100 MB each.');
    const Picker = this.watch.filePickerClass;
    if (!Picker?.uploadPersistent) throw new Error('Foundry V14 persistent file uploads are unavailable. Select a server file instead.');
    const response = await Picker.uploadPersistent(MODULE_ID, 'audio', file, {}, {notify:false});
    const path = response?.path || response?.url || response?.files?.[0];
    if (!path || typeof path !== 'string') throw new Error('Upload finished but Foundry did not return an accessible file path. Check the FilePicker response.');
    parseSource(path);
    await this.saveLibrary([...this.library, {id:id(), title:file.name.replace(/\.[^.]+$/, '').slice(0,120), url:path, loop:false}]);
  }
  playLibrary(idOrName, options = {}) {
    if (!(game.user.isGM || this.watch.canControl)) return false;
    const track = this.library.find(x=>x.id === idOrName || x.title === idOrName);
    if (!track) return false;
    this.watch.issue('PLAY_LIBRARY',{libraryId:track.id,action:options.action === 'queue'?'queue':'interrupt',
      resume:Boolean(options.resume),priority:options.priority ?? 50,force:Boolean(options.force)});
    return true;
  }
  async saveLibrary(entries) { if (!game.user.isGM) return; await game.settings.set(MODULE_ID,'musicLibrary',entries.slice(0,250)); this.renderManager(); }
  async saveTriggers(entries) { if (!game.user.isGM) return; await game.settings.set(MODULE_ID,'musicTriggers',entries.slice(0,250)); this.renderManager(); }
  browse(callback) {
    const Picker = this.watch.filePickerClass;
    if (!Picker) {ui.notifications?.warn('File Picker unavailable'); return;}
    new Picker({type:'audio',callback}).render(true);
  }
  openManager(actorUuid = '') {
    if (!game.user.isGM) { ui.notifications?.warn('The music library and encounter triggers are GM-managed.'); return; }
    this.actorHint = actorUuid || this.actorHint || '';
    if (!this.dialog) {
      this.dialog = document.createElement('section'); this.dialog.id = 'fwr-manager';
      this.dialog.className = 'fwr-manager';
      this.dialog.setAttribute('role', 'dialog'); this.dialog.setAttribute('aria-label','Watch Room music and event triggers');
      this.dialog.addEventListener('click', e => this.managerClick(e));
      this.dialog.addEventListener('submit', e => this.managerSubmit(e));
      this.dialog.addEventListener('pointerdown', () => raise(this.dialog));
      closeOnEscape(this.dialog, () => this.closeManager());
      document.body.append(this.dialog);
    }
    // Reopening after close previously did nothing: renderManager() skips hidden dialogs.
    this.dialog.hidden = false;
    raise(this.dialog);
    this.renderManager();
    this.dialog.querySelector('[data-manager-close]')?.focus();
  }
  closeManager() {
    if (this.dialog) this.dialog.hidden = true;
  }
  renderManager() {
    if (!this.dialog?.isConnected || this.dialog.hidden) return;
    // Settings changes re-render everything; keep the user's scroll position and search term.
    const term = this.dialog.querySelector('[data-search-library]')?.value || '';
    preserveScroll(this.dialog, ['.fwr-manager-scroll', '.fwr-manager-list'], () => this.renderManagerHTML());
    const search = this.dialog.querySelector('[data-search-library]');
    if (search && term) { search.value = term; search.dispatchEvent(new Event('input')); }
  }
  renderManagerHTML() {
    const worldActors = game.actors?.contents || [];
    const actors = worldActors.map(a => `<option value="${esc(a.uuid)}" ${this.actorHint === a.uuid ? 'selected':''}>${esc(a.name)}</option>`).join('');
    this.dialog.innerHTML = `
      <div class="fwr-manager-inner">
        <header><h2><i class="fa-solid fa-music"></i> Watch Room · Music & Triggers</h2><div><button type="button" data-mgr="open-director">⚜ Cinematic Director</button> <button type="button" data-manager-close aria-label="Close manager">✕</button></div></header>
        <div class="fwr-manager-scroll">
          <h3>Saved music library <small>${this.library.length} tracks</small></h3>
          <p class="fwr-manager-note">Searchable, reusable tracks with tags and stable IDs. Use in boss profiles, cinematics, trigger rules and macros.</p>
          <input type="search" data-search-library placeholder="Search tracks, tags or category" aria-label="Search music library">
          <form data-library-form class="fwr-manager-form">
            <input name="editId" type="hidden" value="">
            <input name="title" placeholder="Track title" maxlength="120" required aria-label="Track title">
            <input name="url" placeholder="Server audio path or direct audio URL" maxlength="2048" required aria-label="Audio URL">
            <input name="category" placeholder="Category, e.g. Boss" maxlength="50">
            <input name="tags" placeholder="Tags, comma-separated" maxlength="200">
            <button type="button" data-mgr="browse">Browse server</button><button type="submit">Save / update track</button>
          </form>
          <label class="fwr-upload">Upload audio (MP3 / OGG / WAV / M4A / FLAC / AAC / OPUS)
            <input type="file" data-upload accept=".mp3,.ogg,.opus,.wav,.m4a,.aac,.flac,audio/*"></label>
          <div class="fwr-manager-list">${this.library.map(track => `<div class="fwr-manager-item" data-library-item data-search="${esc(`${track.title} ${track.category || ''} ${(track.tags || []).join(' ')}`.toLowerCase())}">
            <span title="${esc(track.url)}">${esc(track.title)} <small>${esc(track.category||'')} ${esc((track.tags||[]).join(', '))}</small> ${track.loop ? '<small>↻ loop</small>':''}</span>
            <button type="button" data-mgr="library-play" data-id="${esc(track.id)}" title="Play immediately">▶</button>
            <button type="button" data-mgr="library-queue" data-id="${esc(track.id)}" title="Queue">+</button>
            <button type="button" data-mgr="library-edit" data-id="${esc(track.id)}" title="Edit track title, category and tags">Edit</button>
            <button type="button" data-mgr="library-loop" data-id="${esc(track.id)}" title="Toggle saved track loop" aria-pressed="${Boolean(track.loop)}">↻</button>
            <button type="button" data-mgr="library-delete" data-id="${esc(track.id)}" title="Remove from library">✕</button></div>`).join('') || '<p>No saved tracks yet.</p>'}</div>
          <h3>Encounter & event triggers <small>${this.triggers.length} rules</small></h3>
          <form data-trigger-form class="fwr-trigger-form">
            <input name="name" placeholder="Trigger name, e.g. Boss Theme" required maxlength="100" aria-label="Trigger name">
            <label>Event<select name="event">${Object.entries(events).map(([k,v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
            <label>Track<select name="libraryId" required><option value="">Select track</option>${this.library.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></label>
            <label>Creature (optional)<select name="actorPreset"><option value="">Any creature</option>${actors}</select></label>
            <input name="actorUuid" placeholder="Actor UUID (auto-filled from sheet or list)" value="${esc(this.actorHint)}" aria-label="Actor UUID">
            <label>Scene (optional)<select name="sceneId"><option value="">Any scene</option>${(game.scenes?.contents || []).map(sc => `<option value="${esc(sc.id)}">${esc(sc.name)}</option>`).join('')}</select></label>
            <label>Priority (0–100)<input name="priority" type="number" min="0" max="100" value="50"></label>
            <label>When triggered<select name="action"><option value="interrupt">Play immediately</option><option value="queue">Add to queue</option></select></label>
            <label class="fwr-manager-check"><input type="checkbox" name="resume" checked> Resume previous track after interruption</label>
            <button type="submit">Save trigger</button>
          </form>
          <div class="fwr-manager-list">${this.triggers.map(r => {
            const track = this.library.find(x => x.id === r.libraryId);
            return `<div class="fwr-manager-item"><span><strong>${esc(r.name)}</strong><small>${esc(events[r.event] || r.event)} • ${esc(track?.title || 'Missing track')} • ${r.action === 'queue'?'Queue':'Interrupt'}${r.resume?' · resume':''} · P${esc(r.priority ?? 50)}${r.actorUuid ? ` · ${esc(globalThis.fromUuidSync?.(r.actorUuid)?.name || 'actor')}` : ''}</small></span>
              ${r.event === 'manual' ? `<button data-mgr="run-trigger" data-id="${esc(r.id)}">▶</button>`:''}
              <button data-mgr="toggle-trigger" data-id="${esc(r.id)}">${r.enabled ? 'Enabled':'Disabled'}</button>
              <button data-mgr="delete-trigger" data-id="${esc(r.id)}">✕</button></div>`;
          }).join('') || '<p>No rules yet.</p>'}</div>
          <p class="fwr-manager-note">Manual macro: <code>game.modules.get('foundry-watch-room').api.trigger('Boss Theme')</code>. Only enabled manual rules run this way. Encounter triggers run without a vote.</p>
        </div>
      </div>`;
    this.dialog.querySelector('[data-search-library]')?.addEventListener('input', ev => {
      const term=ev.target.value.trim().toLowerCase();
      for(const el of this.dialog.querySelectorAll('[data-library-item]')) el.hidden = !el.dataset.search.includes(term);
    });
    this.dialog.querySelector('[name="actorPreset"]')?.addEventListener('change', e => {
      this.dialog.querySelector('[name="actorUuid"]').value = e.target.value;
    });
    this.dialog.querySelector('[data-upload]')?.addEventListener('change', async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try { await this.upload(file); ui.notifications?.info(`Saved audio: ${file.name}`); }
      catch (err) {ui.notifications?.error(err.message);}
      finally {e.target.value='';}
    });
  }
  async managerClick(event) {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-manager-close')) {this.closeManager();return;}
    const act = button.dataset.mgr; const key = button.dataset.id;
    if (act === 'open-director') return this.watch.director.open(this.actorHint);
    if (act === 'browse') return this.browse(path => {const el = this.dialog?.querySelector('[name="url"]'); if (el) el.value = path;});
    const track = this.library.find(x => x.id === key);
    if (act === 'library-play' && track) return this.playLibrary(track.id,{action:'interrupt',force:true});
    if (act === 'library-queue' && track) return this.playLibrary(track.id,{action:'queue'});
    if (act === 'library-edit' && track) {
      const form=this.dialog?.querySelector('[data-library-form]'); if(!form) return;
      form.elements.editId.value=track.id;form.elements.title.value=track.title;
      form.elements.url.value=track.url;form.elements.category.value=track.category||'';
      form.elements.tags.value=(track.tags||[]).join(', '); form.elements.title.focus();return;
    }
    if (act === 'library-loop' && track) return this.saveLibrary(this.library.map(x => x.id===key ? {...x,loop:!x.loop}:x));
    if (act === 'library-delete' && track) {
      const uses = this.references(key);
      const note = uses ? ` It is used by ${uses} trigger${uses === 1 ? '' : 's'}, phase${uses === 1 ? '' : 's'} or cinematic step${uses === 1 ? '' : 's'}, which will stop working.` : '';
      if (!(await confirmDialog('Remove track?', `Remove “${esc(track.title)}” from the library?${note}`))) return;
      return this.saveLibrary(this.library.filter(x=>x.id!==key));
    }
    const rule = this.triggers.find(x => x.id === key);
    if (act === 'run-trigger' && rule) return this.manual(rule.id);
    if (act === 'toggle-trigger' && rule) return this.saveTriggers(this.triggers.map(x=>x.id===key ? {...x,enabled:!x.enabled}:x));
    if (act === 'delete-trigger' && rule) return this.saveTriggers(this.triggers.filter(x=>x.id!==key));
  }
  /** How many triggers, boss phases and cinematic steps point at a library track. */
  references(trackId) {
    let count = this.triggers.filter(t => t.libraryId === trackId).length;
    for (const p of game.settings.get(MODULE_ID, 'encounterProfiles') || [])
      count += [...(p.phases || []), ...(p.triggers || [])].filter(r => r.libraryId === trackId).length;
    for (const c of game.settings.get(MODULE_ID, 'cinematicCues') || [])
      count += (c.steps || []).filter(st => st.action === 'track' && st.refId === trackId).length;
    return count;
  }
  async managerSubmit(event) {
    if (!event.target.matches('[data-library-form],[data-trigger-form]')) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    try {
      if (event.target.matches('[data-library-form]')) {
        parseSource(data.url);
        const entry = {id:data.editId || id(),title:data.title.trim().slice(0,120),url:data.url.trim(),
          category:(data.category||'').trim().slice(0,50),
          tags:[...new Set((data.tags||'').split(',').map(v=>v.trim().slice(0,40)).filter(Boolean))].slice(0,12),
          loop:this.library.find(x=>x.id===data.editId)?.loop||false};
        await this.saveLibrary(data.editId ? this.library.map(x=>x.id===data.editId?entry:x) : [...this.library,entry]);
      } else {
        if (!this.library.some(x=>x.id===data.libraryId)) throw new Error('Select a saved track first.');
        if (!events[data.event]) throw new Error('Choose a valid event.');
        await this.saveTriggers([...this.triggers, {
          id:id(),name:data.name.trim().slice(0,100),event:data.event,libraryId:data.libraryId,
          actorUuid:requireActor.has(data.event) ? (data.actorUuid||data.actorPreset||'').trim(): '',
          sceneId:data.event === 'scene' ? (data.sceneId||'') : (data.sceneId||''),
          action:data.action==='queue'?'queue':'interrupt',resume: data.resume === 'on',priority: Math.min(100, Math.max(0, Number(data.priority)||0)),enabled:true
        }]);
      }
    } catch(e) {ui.notifications?.error(e.message);}
  }
}
