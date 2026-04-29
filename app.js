import mqtt from "https://esm.sh/mqtt@5.10.4";

const ROOM_ID = "jambin-online-edit-main";
const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const TOPIC = `online-edit/${ROOM_ID}`;
const CHUNK_SIZE = 24 * 1024;
const PRESENCE_TTL = 25000;
const PING_INTERVAL = 10000;
const BROADCAST_DELAY = 120;

const editor = document.querySelector("#editor");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const peerCount = document.querySelector("#peer-count");

const clientId = `client-${crypto.randomUUID()}`;
const peers = new Map([[clientId, Date.now()]]);
const incomingTransfers = new Map();

let currentVersion = createVersion();
let pendingTimer = 0;
let lastBroadcastText = "";

const client = mqtt.connect(BROKER_URL, {
  clean: true,
  connectTimeout: 5000,
  reconnectPeriod: 1500,
  clientId,
});

function createVersion() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function compareVersions(left, right) {
  return left.localeCompare(right);
}

function encodeBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function chunkText(text) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];

  for (let index = 0; index < bytes.length; index += CHUNK_SIZE) {
    chunks.push(encodeBase64(bytes.subarray(index, index + CHUNK_SIZE)));
  }

  return chunks.length > 0 ? chunks : [""];
}

function mergeChunks(chunks) {
  const totalLength = chunks.reduce(
    (length, chunk) => length + decodeBase64(chunk).length,
    0,
  );
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    const bytes = decodeBase64(chunk);
    merged.set(bytes, offset);
    offset += bytes.length;
  }

  return new TextDecoder().decode(merged);
}

function publish(message) {
  if (!client.connected) {
    return;
  }

  client.publish(TOPIC, JSON.stringify(message), { qos: 0, retain: false });
}

function updatePresence(id) {
  peers.set(id, Date.now());
  cleanupPresence();
}

function cleanupPresence() {
  const now = Date.now();
  for (const [id, lastSeen] of peers.entries()) {
    if (id === clientId) {
      continue;
    }

    if (now - lastSeen > PRESENCE_TTL) {
      peers.delete(id);
    }
  }

  peerCount.textContent = String(peers.size);
}

function setStatus(connected) {
  statusDot.classList.toggle("is-live", connected);
  statusText.textContent = connected ? "live" : "reconnecting";
}

function publishPresence(kind = "ping", target = null) {
  publish({
    type: "presence",
    kind,
    from: clientId,
    target,
    version: currentVersion,
  });
}

function publishDocument(text, reason) {
  if (!client.connected) {
    return;
  }

  const transferId = crypto.randomUUID();
  const version = createVersion();
  const chunks = chunkText(text);

  currentVersion = version;
  lastBroadcastText = text;
  updatePresence(clientId);

  chunks.forEach((chunk, index) => {
    publish({
      type: "document",
      reason,
      from: clientId,
      version,
      transferId,
      index,
      total: chunks.length,
      chunk,
    });
  });
}

function applyIncomingDocument(message) {
  const key = `${message.from}:${message.transferId}`;
  const existing = incomingTransfers.get(key) ?? {
    version: message.version,
    total: message.total,
    chunks: new Array(message.total),
    received: 0,
  };

  if (existing.chunks[message.index] == null) {
    existing.chunks[message.index] = message.chunk;
    existing.received += 1;
  }

  incomingTransfers.set(key, existing);

  if (existing.received !== existing.total) {
    return;
  }

  incomingTransfers.delete(key);

  if (compareVersions(message.version, currentVersion) < 0) {
    return;
  }

  currentVersion = message.version;
  const nextText = mergeChunks(existing.chunks);
  if (editor.value !== nextText) {
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;
    editor.value = nextText;
    editor.setSelectionRange(
      Math.min(selectionStart, nextText.length),
      Math.min(selectionEnd, nextText.length),
    );
  }
}

function scheduleBroadcast() {
  window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    const nextText = editor.value;
    if (nextText !== lastBroadcastText) {
      publishDocument(nextText, "edit");
    }
  }, BROADCAST_DELAY);
}

client.on("connect", () => {
  setStatus(true);
  client.subscribe(TOPIC, (error) => {
    if (error) {
      setStatus(false);
      return;
    }

    updatePresence(clientId);
    publishPresence("hello");
    if (editor.value.length > 0) {
      window.setTimeout(() => {
        publishDocument(editor.value, "announce");
      }, 180);
    }
  });
});

client.on("reconnect", () => {
  setStatus(false);
});

client.on("close", () => {
  setStatus(false);
});

client.on("message", (_topic, payload) => {
  let message;

  try {
    message = JSON.parse(String(payload));
  } catch {
    return;
  }

  if (!message || message.from === clientId) {
    return;
  }

  updatePresence(message.from);

  if (message.type === "presence") {
    if (
      message.kind === "hello" &&
      message.target == null &&
      client.connected
    ) {
      window.setTimeout(() => {
        publishPresence("pong", message.from);
        if (editor.value.length > 0 || lastBroadcastText.length > 0) {
          publishDocument(editor.value, "hello-response");
        }
      }, 80 + Math.floor(Math.random() * 180));
    }
    return;
  }

  if (message.type === "document") {
    applyIncomingDocument(message);
  }
});

editor.addEventListener("input", () => {
  scheduleBroadcast();
});

window.setInterval(() => {
  updatePresence(clientId);
  if (client.connected) {
    publishPresence();
  }
}, PING_INTERVAL);

window.addEventListener("beforeunload", () => {
  window.clearTimeout(pendingTimer);
  if (editor.value !== lastBroadcastText) {
    publishDocument(editor.value, "beforeunload");
  }
  client.end(true);
});

setStatus(false);
cleanupPresence();
