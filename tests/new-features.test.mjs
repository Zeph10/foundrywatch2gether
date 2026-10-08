import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSource, initialState, reduceIntent, reduceWithAutoOpen, expectedPosition} from '../scripts/state.js';
const gm = {id:'gm',active:true,isGM:true,role:4};
const host = {id:'host',active:true,isGM:false,role:2};
const p1 = {id:'p1',active:true,isGM:false,role:1};
const p2 = {id:'p2',active:true,isGM:false,role:1};
const users = new Map([gm,host,p1,p2].map(x=>[x.id,x]));
let now=1_000_000;
function send(s,type,actor=gm,props={},at=now){return reduceIntent(s,{type,...props},actor,users,2,at);}
function open() {return send(initialState(),'OPEN');}
const music = 'worlds/demo/encounters/boss.mp3';
const a='https://youtu.be/aaaaaaaaaaa';
const b='https://youtu.be/bbbbbbbbbbb';

test('Audio formats validated, malicious protocols rejected',()=>{
  for(const ext of ['mp3','ogg','wav','m4a','aac','flac','opus']) {
    const entry=parseSource(`worlds/demo/music/track.${ext}`);
    assert.equal(entry.provider,'file');
    assert.equal(entry.audio,true,ext);
  }
  assert.equal(parseSource('storage/modules/foundry-watch-room/audio/boss.mp3').audio,true);
  assert.equal(parseSource('https://foo.invalid/music.ogg').audio,true);
  assert.throws(()=>parseSource('file:///tmp/secret.mp3'));
  assert.throws(()=>parseSource('data:audio/mpeg;base64,YQ=='));
});

test('Loop current and individual track; manual skip still advances',()=>{
  let s=open();
  s=send(s,'ADD',gm,{url:music,title:'Boss',loop:true});
  s=send(s,'ADD',gm,{url:b});
  s=send(s,'PLAY');
  const uid=s.current.uid;
  s=send(s,'ENDED',gm,{forUid:uid},now+10_000);
  assert.equal(s.current.uid,uid);
  assert.equal(s.position,0);
  s=send(s,'NEXT');
  assert.equal(s.current.id,'bbbbbbbbbbb');
  s=send(s,'LOOP_MODE',gm,{mode:'one'});
  const prev=s.current.uid;
  s=send(s,'ENDED',gm,{forUid:prev},now+30_000);
  assert.equal(s.current.uid,prev);
});

test('Loop whole queue cycles and preserves track',()=>{
  let s=open();s=send(s,'ADD',gm,{url:a});s=send(s,'ADD',gm,{url:b});
  s=send(s,'LOOP_MODE',gm,{mode:'queue'});s=send(s,'PLAY');
  s=send(s,'ENDED',gm,{forUid:s.current.uid},now+10_000);
  assert.equal(s.current.id,'bbbbbbbbbbb');
  assert.deepEqual(s.queue.map(x=>x.id),['aaaaaaaaaaa']);
  s=send(s,'ENDED',gm,{forUid:s.current.uid},now+20_000);
  assert.equal(s.current.id,'aaaaaaaaaaa');
  assert.deepEqual(s.queue.map(x=>x.id),['bbbbbbbbbbb']);
});

test('Encounter triggers queue, interrupt and resume time/playing state',()=>{
  let s=open();s=send(s,'ADD',gm,{url:a});s=send(s,'PLAY');
  s=send(s,'TRIGGER',gm,{url:music,title:'Boss',action:'interrupt',resume:true},now+40_000);
  assert.equal(s.current.title,'Boss');
  assert.equal(s.resumeStack.length,1);
  assert.equal(s.resumeStack[0].position,40);
  s=send(s,'ENDED',gm,{forUid:s.current.uid},now+55_000);
  assert.equal(s.current.id,'aaaaaaaaaaa');
  assert.equal(s.position,40);
  assert.equal(s.playing,true);
  s=send(s,'TRIGGER',gm,{url:music,action:'queue'},now+56_000);
  assert.equal(s.queue.length,1);
  assert.equal(send(s,'TRIGGER',p1,{url:music,action:'interrupt'}),null);
});

test('Majority vote for song changes, GM override, and timeout',()=>{
  let s=open();s=send(s,'ADD',gm,{url:a});s=send(s,'ADD',gm,{url:b});
  s=send(s,'VOTE_MODE',gm,{enabled:true});
  assert.equal(send(s,'NEXT',host),null);
  s=send(s,'PROPOSE',host,{action:'NEXT'});
  assert.ok(s.pendingVote);assert.equal(s.pendingVote.yes.length,1);
  s=send(s,'VOTE',p1,{id:s.pendingVote.id,yes:true});
  assert.equal(s.pendingVote,null,'two votes are a majority of three active non-GMs');
  s=send(s,'VOTE_MODE',gm,{enabled:true});
  assert.equal(s.pendingVote,null);
  assert.equal(s.current.id,'bbbbbbbbbbb');
  s=send(s,'PROPOSE',host,{action:'NEXT'});
  assert.ok(s.pendingVote);
  s=send(s,'VOTE_OVERRIDE',gm,{approve:false});
  assert.equal(s.pendingVote,null);
  s=send(s,'PROPOSE',host,{action:'NEXT'});
  s=send(s,'VOTE_TIMEOUT',gm,{},s.pendingVote.expiresAt+1);
  assert.equal(s.pendingVote,null);
});

test('No unauthorized toggle, proposal stale uid, invalid trigger URL',()=>{
  let s=open(); s=send(s,'ADD',gm,{url:a});
  assert.equal(send(s,'VOTE_MODE',p1,{enabled:true}),null);
  assert.equal(send(s,'LOOP_MODE',p1,{mode:'queue'}),null);
  assert.equal(send(s,'TRACK_LOOP',p1,{uid:s.current.uid,loop:true}),null);
  s=send(s,'VOTE_MODE',gm,{enabled:true});
  assert.equal(send(s,'PROPOSE',p1,{action:'SELECT',uid:'bogus'}),null);
  assert.equal(send(s,'TRIGGER',gm,{url:'javascript:alert(1)',action:'interrupt'}),null);
});

test('Automation opens a closed room in one transaction; players and manual intents do not',()=>{
  const closed=initialState();
  const cue={type:'TRIGGER',url:music,title:'Boss',action:'interrupt',priority:80};
  const s=reduceWithAutoOpen(closed,cue,gm,users,2,now);
  assert.equal(s.open,true);
  assert.equal(s.hostId,'gm');
  assert.equal(s.current.title,'Boss');
  assert.equal(s.playing,true);
  assert.equal(reduceWithAutoOpen(closed,cue,gm,users,2,now,false),null,'setting off');
  assert.equal(reduceWithAutoOpen(closed,cue,p1,users,2,now),null,'players cannot');
  assert.equal(reduceWithAutoOpen(closed,{type:'PLAY'},gm,users,2,now),null,'only automation intents');
  const cine=reduceWithAutoOpen(closed,{type:'DIRECTOR_START',cueId:'c1',title:'Intro',focus:true},gm,users,2,now);
  assert.equal(cine.open,true); assert.equal(cine.cinematicFocus,true);
});

test('A late duplicate ENDED from a second controller does not restart a looping track again',()=>{
  let s=open();
  s=send(s,'ADD',gm,{url:music,title:'Loop',loop:true});
  s=send(s,'PLAY',gm,{},now);
  const uid=s.current.uid;
  s=send(s,'ENDED',gm,{forUid:uid,duration:30},now+30_000);
  assert.equal(s.current.uid,uid); assert.equal(s.startedAt,now+30_000);
  assert.equal(send(s,'ENDED',gm,{forUid:uid,duration:30},now+30_400),null,'stale controller report rejected');
  assert.equal(send(s,'ENDED',host,{forUid:uid,duration:30},now+30_400),null,'stale viewer report rejected');
  assert.ok(send(s,'ENDED',host,{forUid:uid,duration:30},now+60_100),'next real end accepted');
});
