import test from 'node:test';
import assert from 'node:assert/strict';
import { crossedPhases, hpPercent, dynamicMatches, profileMatches, dueSteps, shouldInterrupt, actorMatches } from '../scripts/director-core.js';
import { initialState, reduceIntent, expectedPosition } from '../scripts/state.js';
const gm={id:'gm',role:4,active:true,isGM:true};
const player={id:'player',role:1,active:true,isGM:false};
const users=new Map([[gm.id,gm],[player.id,player]]);
const actor={uuid:'Actor.boss',id:'boss',system:{attributes:{hp:{value:42,max:100}}}};
const newRoom=()=>reduceIntent(initialState(),{type:'OPEN'},gm,users,1,1000);
const trigger=(state, name, priority=50, extra={}, at=2000)=>reduceIntent(state,{type:'TRIGGER',url:`https://example.com/${name}.mp3`,title:name,action:'interrupt',priority,...extra},gm,users,1,at);

test('HP percentages and boss phase crossing, heals do not retrigger',()=>{
  assert.equal(hpPercent(actor),42);
  assert.equal(hpPercent({system:{attributes:{hp:{value:4,max:0}}}}),null);
  const phases=[75,50,25].map(n=>({id:String(n),enabled:true,threshold:n}));
  assert.deepEqual(crossedPhases(phases,100,20).map(p=>p.id),['75','50','25']);
  assert.deepEqual(crossedPhases(phases,20,80).map(p=>p.id),[]);
  assert.deepEqual(crossedPhases(phases,80,20,new Set(['75','50'])).map(p=>p.id),['25']);
});
test('Actor UUID and encounter profile matching',()=>{
  assert.equal(actorMatches('Actor.boss',actor),true);
  assert.equal(actorMatches('Actor.other',actor),false);
  const profile={enabled:true,actorUuid:'Actor.boss',sceneId:'scene1'};
  assert.equal(profileMatches(profile,{actor,sceneId:'scene1'}),true);
  assert.equal(profileMatches(profile,{actor,sceneId:'scene2'}),false);
  assert.equal(profileMatches({...profile,enabled:false},{actor,sceneId:'scene1'}),false);
});
test('Dynamic trigger filters spell, condition, round and actor',()=>{
  assert.equal(dynamicMatches({event:'roundStart',enabled:true,round:3},'roundStart',{round:3}),true);
  assert.equal(dynamicMatches({event:'roundStart',enabled:true,round:3},'roundStart',{round:4}),false);
  assert.equal(dynamicMatches({event:'spellCast',enabled:true,match:'Fireball'},'spellCast',{spell:'Greater Fireball'}),true);
  assert.equal(dynamicMatches({event:'conditionAdded',enabled:true,match:'poisoned'},'conditionAdded',{condition:'Poisoned'}),true);
  assert.equal(dynamicMatches({event:'conditionAdded',enabled:true,match:'poisoned'},'conditionRemoved',{condition:'Poisoned'}),false);
  assert.equal(dynamicMatches({event:'initiative',enabled:true,actorUuid:'Actor.other'},'initiative',{actor}),false);
});
test('Director timeline sorts stable offset, ignores repeat and invalid events',()=>{
  const cue={steps:[{id:'c',action:'scene',at:12},{id:'a',action:'track',at:0},{id:'b',action:'focus',at:12},{id:'bad',action:'unknown',at:2}]};
  assert.deepEqual(dueSteps(cue,12).map(s=>s.id),['a','c','b']);
  assert.deepEqual(dueSteps(cue,12,new Set(['a','c'])).map(s=>s.id),['b']);
  assert.deepEqual(dueSteps(cue,11).map(s=>s.id),['a']);
});
test('Priority gates lower priority automatic interrupt, accepts equal priority and queuing',()=>{
  const opened=newRoom();assert.ok(opened);
  const boss=trigger(opened,'boss',85);assert.equal(boss.currentPriority,85);
  assert.equal(trigger(boss,'tavern',20),null);
  const equal=trigger(boss,'equal',85);assert.equal(equal.current?.title,'equal');
  const queued=reduceIntent(boss,{type:'TRIGGER',url:'https://example.com/queued.mp3',title:'queue',action:'queue',priority:3},gm,users,1,3000);
  assert.equal(queued.queue.length,1);
  assert.equal(queued.current.title,'boss');
  assert.equal(shouldInterrupt(40,80),false);
  assert.equal(shouldInterrupt(40,80,true),true);
});
test('Interruption resume restores priority and position, manual override can force',()=>{
  const opened=newRoom();const theme=trigger(opened,'theme',70,{resume:false},2000);
  const phase=trigger(theme,'phase',90,{resume:true},5000);
  assert.equal(phase.resumeStack.length,1);
  assert.equal(phase.resumeStack[0].entry.priority,70);
  assert.equal(Math.round(phase.resumeStack[0].position),3);
  const denied=trigger(phase,'intro',10);assert.equal(denied,null);
  const forced=trigger(phase,'intro',10,{force:true});assert.equal(forced.currentPriority,10);
  const resumed=reduceIntent(phase,{type:'NEXT'},gm,users,1,9000);
  assert.equal(resumed.current.title,'theme');assert.equal(resumed.currentPriority,70);
  assert.equal(Math.round(expectedPosition(resumed,9000)),3);
});
test('Cinematic start focus and stop, only GM can control',()=>{
  const opened=newRoom();
  assert.equal(reduceIntent(opened,{type:'DIRECTOR_START',cueId:'intro'},player,users,1,1001),null);
  const started=reduceIntent(opened,{type:'DIRECTOR_START',cueId:'intro',title:'Boss entrance',focus:true},gm,users,1,1200);
  assert.equal(started.cinematic.cueId,'intro'); assert.equal(started.cinematicFocus,true);
  const dim=reduceIntent(started,{type:'DIRECTOR_FOCUS',enabled:false},gm,users,1,2000);
  assert.equal(dim.cinematicFocus,false);
  const stop=reduceIntent(dim,{type:'DIRECTOR_STOP'},gm,users,1,3000);
  assert.equal(stop.cinematic,null);
  assert.equal(stop.cinematicFocus,false);
});
test('Existing queue and manual player controls survive director additions',()=>{
  const opened=newRoom();const game=trigger(opened,'boss',70);
  const next=reduceIntent(game,{type:'ADD',url:'https://example.com/clip.mp4',title:'Clip'},gm,users,1,2100);
  assert.equal(next.queue.length,1);
  const jump=reduceIntent(next,{type:'SELECT',uid:next.queue[0].uid},gm,users,1,2200);
  assert.equal(jump.current.title,'Clip');assert.equal(jump.currentPriority,0);
});
