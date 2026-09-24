import assert from "node:assert/strict";

const gm1 = { id: "gm-1", isGM: true, active: true };
const gm2 = { id: "gm-2", isGM: true, active: true };
const player = { id: "player-1", isGM: false, active: true };
const player2 = { id: "player-2", isGM: false, active: true };
const users = [gm1, gm2, player, player2];
users.get = id => users.find(user => user.id === id);

const socketListeners = new Map();
const emitted = [];
let socketOnCalls = 0;

globalThis.game = {
  user: gm1,
  users,
  socket: {
    on(name, callback) {
      socketOnCalls += 1;
      socketListeners.set(name, callback);
    },
    emit(name, payload) {
      emitted.push({ name, payload });
    }
  }
};

globalThis.Hooks = {
  on() { return 1; }
};

const { VNSocket } = await import("../scripts/playback/vn-socket.js");
const { PLAYER_MODES, SOCKET_NAME } = await import("../scripts/utils/constants.js");

VNSocket.handlers = {};
VNSocket.activeLeaders.clear();
VNSocket.activeTargets.clear();
VNSocket.activeParticipants.clear();
VNSocket.activeSessions.clear();
VNSocket.ready.clear();
VNSocket.readyTargets.clear();
VNSocket._socketMessageHandler = null;
VNSocket._userConnectedHookId = null;

let trustedAdvanceCalls = 0;
const handlers = {
  advance: () => { trustedAdvanceCalls += 1; }
};
VNSocket.activeLeaders.set("scene-auth", gm1.id);
VNSocket.registerHandlers(handlers);
assert.equal(socketOnCalls, 1, "Socket listener must be registered exactly once");
assert.equal(typeof socketListeners.get(SOCKET_NAME), "function", "Socket listener must use the module namespace");

VNSocket.registerHandlers(handlers);
assert.equal(socketOnCalls, 1, "Repeated handler registration must not duplicate the socket listener");

assert.deepEqual(
  VNSocket._participantIdsForLaunch([player.id, player2.id], PLAYER_MODES.VOTE),
  [player.id, player2.id],
  "Vote sessions must exclude the GM from the participant roster"
);
assert.deepEqual(
  VNSocket._participantIdsForLaunch([player.id], PLAYER_MODES.GM),
  [gm1.id, player.id],
  "Non-vote synchronized modes must retain the GM in their participant metadata"
);

assert.equal(VNSocket.emit("advance", { sceneId: "scene-auth" }), true);
assert.equal(emitted.length, 1);
assert.equal(emitted[0].name, SOCKET_NAME);
assert.equal(emitted[0].payload.senderId, gm1.id, "The sender id must travel inside the module payload");
assert.equal("senderId" in emitted[0].payload.data, false, "Transport metadata must stay outside command data");

const socketCallback = socketListeners.get(SOCKET_NAME);
game.user = gm2;
socketCallback(emitted[0].payload);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trustedAdvanceCalls, 1, "A one-argument Foundry socket callback must dispatch the GM command");

socketCallback({
  type: "advance",
  timestamp: Date.now(),
  senderId: player.id,
  data: { sceneId: "scene-auth" }
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trustedAdvanceCalls, 1, "A non-GM sender must not gain GM command authority");

socketCallback({
  type: "advance",
  timestamp: Date.now(),
  data: { sceneId: "scene-auth" }
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trustedAdvanceCalls, 1, "A payload without sender metadata must be ignored safely");

game.user = gm1;
socketCallback(emitted[0].payload);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trustedAdvanceCalls, 1, "The sender must ignore its own broadcast payload");

const reconnectSceneId = "scene-reconnect";
const reconnectSession = {
  scene: { id: reconnectSceneId, title: "Reconnect" },
  mode: PLAYER_MODES.VOTE,
  leaderId: gm1.id,
  targetIds: [player.id, player2.id],
  participantIds: [player.id, player2.id],
  started: true
};
VNSocket.activeSessions.set(reconnectSceneId, reconnectSession);
VNSocket.activeTargets.set(reconnectSceneId, new Set(reconnectSession.targetIds));
VNSocket.activeParticipants.set(reconnectSceneId, new Set(reconnectSession.participantIds));
VNSocket.activeLeaders.set(reconnectSceneId, gm1.id);

const reconnectEvents = [];
VNSocket.handlers = {
  userConnected: (user, connected) => { reconnectEvents.push({ userId: user.id, connected }); },
  getSyncState: sceneId => sceneId === reconnectSceneId
    ? { currentFrameId: "frame-current", currentTextIndex: 2, counterState: { c: 1 }, visualState: { background: "bg.webp" } }
    : null
};
emitted.length = 0;
VNSocket._onUserConnected(player, false);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(emitted.length, 0, "A disconnect must not destroy the session or send a reopen immediately");
assert.equal(VNSocket.activeSessions.get(reconnectSceneId)?.targetIds.includes(player.id), true, "Disconnected players must remain session targets so they can reconnect");

VNSocket._onUserConnected(player, true);
await new Promise(resolve => setTimeout(resolve, 0));
const reopen = emitted.find(entry => entry.payload?.type === "open" && entry.payload?.data?.sceneId === reconnectSceneId);
assert.ok(reopen, "Reconnect must reopen the active cutscene for the returning player");
assert.deepEqual(reopen.payload.data.targetIds, [player.id], "Reconnect reopen must target only the returning player");
assert.equal(reopen.payload.data.resumeState.currentFrameId, "frame-current", "Reconnect must resume at the GM's current synchronized frame");
assert.deepEqual(reopen.payload.data.participantIds, [player.id, player2.id], "Reconnect must restore the current player-only vote roster");

let leaveHandlerCall = null;
VNSocket.handlers.leave = (data, senderId) => { leaveHandlerCall = { data, senderId }; };
const leavePayload = {
  type: "leave",
  timestamp: Date.now(),
  senderId: player.id,
  data: { sceneId: reconnectSceneId, targetIds: [gm1.id] }
};
socketCallback(leavePayload);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(leaveHandlerCall?.senderId, player.id, "Leader must receive an explicit vote-session leave event");
assert.equal(VNSocket.activeTargets.get(reconnectSceneId).has(player.id), false, "Manual leave must remove the player from future synchronized targets");
assert.equal(VNSocket.activeParticipants.get(reconnectSceneId).has(player.id), false, "Manual leave must remove the player from the persistent vote roster");
assert.equal(VNSocket.activeSessions.get(reconnectSceneId).targetIds.includes(player.id), false, "Manual leave must remove the player from reconnect eligibility for this session");

emitted.length = 0;
VNSocket._onUserConnected(player, true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(emitted.some(entry => entry.payload?.type === "open" && entry.payload?.data?.sceneId === reconnectSceneId), false, "A player who explicitly left must not be auto-reopened by a later reconnect");

VNSocket.activeSessions.delete(reconnectSceneId);
VNSocket.activeTargets.delete(reconnectSceneId);
VNSocket.activeParticipants.delete(reconnectSceneId);
VNSocket.activeLeaders.delete(reconnectSceneId);

console.log("Socket transport smoke tests passed.");
