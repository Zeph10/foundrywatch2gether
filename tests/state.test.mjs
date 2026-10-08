import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, parseStartTime, initialState, expectedPosition, reduceIntent, canControl, canCreate } from '../scripts/state.js';
const gm = { id:'gm', role:4, isGM:true, active:true };
const trusted = { id:'trusted', role:2, isGM:false, active:true };
const viewer = { id:'viewer', role:1, isGM:false, active:true };
const users = new Map([gm,trusted,viewer].map(u=>[u.id,u]));
const when=1_000_000;
const send=(state,type,actor=gm,props={},now=when)=>reduceIntent(state,{type,...props},actor,users,4,now);

test('accept expected sources and reject non-video or executable links',()=>{
  assert.equal(parseSource('https://youtu.be/dQw4w9WgXcQ').provider,'youtube');
  assert.equal(parseSource('https://www.youtube.com/shorts/dQw4w9WgXcQ').id,'dQw4w9WgXcQ');
  assert.equal(parseSource('https://vimeo.com/12345678/bcdef012').hash,'bcdef012');
  assert.equal(parseSource('https://www.twitch.tv/videos/112233').videoType,'vod');
  assert.equal(parseSource('https://www.twitch.tv/twitchdev').live,true);
  assert.equal(parseSource('https://some.domain/video.webm?token=abc').provider,'file');
  assert.equal(parseSource('worlds/my-world/media/clip.mp4').provider,'file');
  for(const url of ['javascript:alert(1)','https://example.com/','https://www.youtube.com/watch?v=invalid','https://twitch.tv/directory']) {
    assert.throws(()=>parseSource(url), {name:'Error'});
  }
});

test('GM permission thresholds and room creation',()=>{
  assert.equal(canCreate(viewer,4),false);
  assert.equal(canCreate(trusted,2),true);
  assert.equal(canCreate(gm,4),true);
  assert.equal(send(initialState(),'OPEN',viewer),null);
  const opened=send(initialState(),'OPEN');
  assert.equal(opened.open,true);
  assert.equal(opened.hostId,'gm');
  assert.ok(opened.roomId);
  assert.equal(send(opened,'OPEN'),null);
});

test('host queue, playback, pause, seek, late join expectedPosition, permissions',()=>{
  let s=send(initialState(),'OPEN');
  assert.equal(send(s,'ADD',viewer,{url:'https://youtu.be/dQw4w9WgXcQ'}),null);
  s=send(s,'ADD',gm,{url:'https://youtu.be/dQw4w9WgXcQ',title:'First'});
  assert.equal(s.current.title,'First');
  assert.equal(s.playing,false);
  s=send(s,'ADD',gm,{url:'https://vimeo.com/123456',title:'Second'});
  assert.equal(s.queue.length,1);
  s=send(s,'PLAY',gm,{},when);
  assert.equal(s.playing,true);
  assert.equal(expectedPosition(s,when+7500),7.5);
  assert.equal(send(s,'PAUSE',viewer,{},when+8000),null);
  s=send(s,'PAUSE',gm,{},when+10000);
  assert.equal(s.position,10);
  assert.equal(expectedPosition(s,when+15000),10);
  s=send(s,'SEEK',gm,{position:37},when+20000);
  assert.equal(s.position,37);
  s=send(s,'GRANT',gm,{userId:'viewer'});
  assert.equal(canControl(s,viewer),true);
  s=send(s,'PLAY',viewer,{},when+25000);
  assert.equal(s.playing,true);
  s=send(s,'NEXT',viewer,{forUid:s.current.uid},when+30000);
  assert.equal(s.current.provider,'vimeo');
  assert.equal(s.queue.length,0);
  assert.equal(s.playing,true);
  s=send(s,'REVOKE',gm,{userId:'viewer'});
  assert.equal(send(s,'PAUSE',viewer),null);
  assert.equal(send(s,'NEXT',gm,{forUid:'stale-id'}),null);
  s=send(s,'NEXT',gm,{},when+35000);
  assert.equal(s.current,null);
  assert.equal(s.playing,false);
});

test('scene placement, host reclaim and room close',()=>{
  let s=reduceIntent(initialState(),{type:'OPEN'},trusted,users,2,when);
  assert.equal(s.hostId,'trusted');
  s=send(s,'SCENE',trusted,{scene:{sceneId:'abc',x:80,y:120,width:900,height:650}});
  assert.equal(s.scene.sceneId,'abc');
  assert.equal(s.scene.width,900);
  assert.equal(send(s,'CLOSE',viewer),null);
  s=send(s,'TAKE_HOST',gm);
  assert.equal(s.hostId,'gm');
  s=send(s,'CLOSE',gm);
  assert.equal(s.open,false);
  assert.equal(send(s,'PLAY'),null);
});

test('parser hardening: clips host, vimeo hash validation, malformed escapes, start times',()=>{
  assert.throws(()=>parseSource('https://clips.twitch.tv/SomeClipSlug'), /clips/);
  assert.equal(parseSource('https://player.vimeo.com/video/123456?h=../../evil').hash,'');
  assert.equal(parseSource('https://player.vimeo.com/video/123456?h=abcdef12').hash,'abcdef12');
  assert.equal(parseSource('https://cdn.example.com/%E0%A4%A.mp4').provider,'file');
  assert.equal(parseSource('https://youtu.be/dQw4w9WgXcQ?t=90').start,90);
  assert.equal(parseSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s').start,90);
  assert.equal(parseSource('https://www.twitch.tv/videos/112233?t=1h2m3s').start,3723);
  assert.equal(parseSource('https://vimeo.com/123456#t=45s').start,45);
  assert.equal(parseStartTime('garbage'),0);
});

test('start time is applied when a video becomes current',()=>{
  let s=send(initialState(),'OPEN');
  s=send(s,'ADD',gm,{url:'https://youtu.be/dQw4w9WgXcQ?t=42'});
  assert.equal(s.position,42);
  s=send(s,'ADD',gm,{url:'https://vimeo.com/123456#t=10'});
  s=send(s,'NEXT',gm,{},when+1000);
  assert.equal(s.position,10);
  assert.equal(expectedPosition(s,when+3000),12);
});

test('ENDED: viewers can advance only a video that has really run out',()=>{
  let s=send(initialState(),'OPEN');
  s=send(s,'ADD',gm,{url:'https://youtu.be/dQw4w9WgXcQ'});
  s=send(s,'ADD',gm,{url:'https://vimeo.com/123456'});
  s=send(s,'PLAY',gm,{},when);
  const uid=s.current.uid;
  assert.equal(send(s,'ENDED',viewer,{forUid:uid,duration:120},when+30_000),null, 'too early');
  assert.equal(send(s,'ENDED',viewer,{forUid:'other',duration:20},when+30_000),null, 'wrong uid');
  assert.equal(send(s,'ENDED',viewer,{forUid:uid},when+30_000),null, 'no duration');
  const next=send(s,'ENDED',viewer,{forUid:uid,duration:30},when+30_000);
  assert.equal(next.current.provider,'vimeo');
  assert.equal(send(next,'ENDED',viewer,{forUid:uid,duration:30},when+30_100),null, 'duplicate report');
  const paused=send(s,'PAUSE',gm,{},when+29_000);
  assert.equal(send(paused,'ENDED',viewer,{forUid:uid,duration:29},when+40_000),null, 'paused room');
  assert.ok(send(s,'ENDED',gm,{forUid:uid},when+1000), 'controllers may always report');
});

test('MOVE reorders the queue within bounds',()=>{
  let s=send(initialState(),'OPEN');
  for (const id of ['aaaaaaaaaaa','bbbbbbbbbbb','ccccccccccc','ddddddddddd']) s=send(s,'ADD',gm,{url:`https://youtu.be/${id}`});
  assert.deepEqual(s.queue.map(e=>e.id),['bbbbbbbbbbb','ccccccccccc','ddddddddddd']);
  s=send(s,'MOVE',gm,{uid:s.queue[2].uid,delta:-1});
  assert.deepEqual(s.queue.map(e=>e.id),['bbbbbbbbbbb','ddddddddddd','ccccccccccc']);
  assert.equal(send(s,'MOVE',gm,{uid:s.queue[0].uid,delta:-1}),null);
  assert.equal(send(s,'MOVE',viewer,{uid:s.queue[1].uid,delta:1}),null);
});

test('TAKE_HOST is a no-op for the current host and REVOKE needs an existing grant',()=>{
  let s=send(initialState(),'OPEN');
  assert.equal(send(s,'TAKE_HOST',gm),null);
  assert.equal(send(s,'REVOKE',gm,{userId:'viewer'}),null);
});
