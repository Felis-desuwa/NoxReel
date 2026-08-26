'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

/** 够用的假 RTCPeerConnection：只关心远端描述和候选地址的先后关系。 */
class FakePeerConnection {
  constructor() {
    this.remoteDescription = null;
    this.localDescription = null;
    this.iceGatheringState = 'complete';
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.added = [];
    this.channels = [];
  }
  createDataChannel(label) {
    const ch = { label, readyState: 'connecting', binaryType: '', addEventListener() {}, removeEventListener() {}, close() {} };
    this.channels.push(ch);
    return ch;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer', toJSON() { return { type: 'offer', sdp: 'v=0 offer' }; } };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0 answer', toJSON() { return { type: 'answer', sdp: 'v=0 answer' }; } };
  }
  async setLocalDescription(desc) {
    this.localDescription = { ...desc, toJSON: () => desc };
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }
  async addIceCandidate(candidate) {
    // 浏览器的真实行为：远端描述还没设进去就加候选，直接抛错。
    if (!this.remoteDescription) throw new Error('The remote description was null');
    this.added.push(candidate);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

async function loadPeer(dir) {
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.performance = globalThis.performance || { now: () => 0 };
  return (await import(dir + 'peer.js')).Peer;
}


function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/**
 * trickle 模式下 offer 和候选地址是并发到达的，而 setRemoteDescription 是异步的。
 * 早到的候选（往往正是最有用的同网段主机候选）如果直接丢掉，就会间歇性连不上。
 */
impl('远端描述落地前到达的 ICE 候选会排队，不会被丢掉', async (dir) => {
  const Peer = await loadPeer(dir);
  const peer = new Peer({ peerId: 'other', name: 'other', initiator: true, iceServers: [] });

  await peer.addIceCandidate({ candidate: 'early-1' });
  await peer.addIceCandidate({ candidate: 'early-2' });
  assert.equal(peer.pc.added.length, 0, '这时候还加不进去');

  await peer.acceptAnswer({ type: 'answer', sdp: 'v=0 answer' });

  assert.deepEqual(
    peer.pc.added.map((c) => c.candidate),
    ['early-1', 'early-2'],
    '远端描述落地后要把排队的候选补上'
  );

  await peer.addIceCandidate({ candidate: 'late-1' });
  assert.equal(peer.pc.added.length, 3, '之后到达的候选照常直接加');
});

impl('应答方接收 offer 后同样会补上排队的候选', async (dir) => {
  const Peer = await loadPeer(dir);
  const peer = new Peer({ peerId: 'other', name: 'other', initiator: false, iceServers: [] });

  await peer.addIceCandidate({ candidate: 'early' });
  await peer.acceptOffer({ type: 'offer', sdp: 'v=0 offer' });

  assert.deepEqual(peer.pc.added.map((c) => c.candidate), ['early']);
});
