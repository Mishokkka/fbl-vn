import assert from "node:assert/strict";

const gm1 = { id: "gm-1", isGM: true, active: true };
const gm2 = { id: "gm-2", isGM: true, active: true };
const player = { id: "player-1", isGM: false, active: true };
const users = [gm1, gm2, player];
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
const { SOCKET_NAME } = await import("../scripts/utils/constants.js");

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

console.log("Socket transport smoke tests passed.");
