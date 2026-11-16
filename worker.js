const MAX_VIEWERS = 4;

function constantTimeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function attachmentOf(socket) {
  try { return socket.deserializeAttachment() || {}; }
  catch { return {}; }
}

function safeSend(socket, payload) {
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "PocketCam signaling",
        version: 3,
        passwordConfigured: Boolean(env.POCKETCAM_PASSWORD),
        maxViewers: MAX_VIEWERS
      });
    }

    if (url.pathname === "/ws") {
      if (!env.POCKETCAM_PASSWORD) {
        return new Response("PocketCam viewer password is not configured on this Worker.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const id = env.ROOMS.idFromName("pocketcam-single-room");
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response("PocketCam signaling service", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      safeSend(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (message.type === "ping") {
      safeSend(socket, { type: "pong" });
      return;
    }

    const attachment = attachmentOf(socket);

    if (!attachment.authenticated) {
      if (message.type !== "hello" || !["camera", "viewer"].includes(message.role)) {
        safeSend(socket, { type: "error", message: "Authentication required" });
        socket.close(1008, "Authentication required");
        return;
      }

      // The camera starts without a typed password. Viewers must authenticate.
      if (message.role === "viewer") {
        const expectedPassword = this.env.POCKETCAM_PASSWORD || "";
        const suppliedPassword = String(message.password || "");
        if (!expectedPassword || !constantTimeEqual(suppliedPassword, expectedPassword)) {
          safeSend(socket, {
            type: "error",
            message: "觀看密碼錯誤，或 Worker 尚未設定觀看密碼"
          });
          socket.close(1008, "Password rejected");
          return;
        }
      }

      const sockets = this.ctx.getWebSockets();
      const active = sockets
        .filter(other => other !== socket)
        .map(other => ({ socket: other, data: attachmentOf(other) }))
        .filter(item => item.data.authenticated);

      if (message.role === "camera" && active.some(item => item.data.role === "camera")) {
        safeSend(socket, { type: "error", message: "目前已有攝影機直播" });
        socket.close(1008, "Camera already connected");
        return;
      }

      const viewers = active.filter(item => item.data.role === "viewer");
      if (message.role === "viewer" && viewers.length >= MAX_VIEWERS) {
        safeSend(socket, {
          type: "error",
          message: "目前觀看人數已滿（最多 " + MAX_VIEWERS + " 位）"
        });
        socket.close(1013, "Viewer limit reached");
        return;
      }

      const clientId = String(message.clientId || crypto.randomUUID()).slice(0, 80);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientId)) {
        safeSend(socket, { type: "error", message: "Invalid client ID" });
        socket.close(1008, "Invalid client ID");
        return;
      }

      socket.serializeAttachment({
        authenticated: true,
        role: message.role,
        clientId
      });

      safeSend(socket, {
        type: "authenticated",
        role: message.role,
        clientId,
        maxViewers: MAX_VIEWERS
      });

      if (message.role === "camera") {
        for (const item of viewers) {
          safeSend(socket, {
            type: "peer-ready",
            role: "viewer",
            peerId: item.data.clientId
          });
          safeSend(item.socket, {
            type: "peer-ready",
            role: "camera",
            peerId: clientId
          });
        }
      } else {
        const camera = active.find(item => item.data.role === "camera");
        if (camera) {
          safeSend(camera.socket, {
            type: "peer-ready",
            role: "viewer",
            peerId: clientId
          });
          safeSend(socket, {
            type: "peer-ready",
            role: "camera",
            peerId: camera.data.clientId
          });
        }
      }
      return;
    }

    if (!["offer", "answer", "candidate", "hangup"].includes(message.type)) return;

    const targetId = String(message.target || "");
    if (!targetId || targetId === attachment.clientId) {
      safeSend(socket, { type: "error", message: "Signal target is missing or invalid" });
      return;
    }

    const allowed =
      attachment.role === "camera"
        ? ["offer", "candidate", "hangup"].includes(message.type)
        : ["answer", "candidate", "hangup"].includes(message.type);

    if (!allowed) {
      safeSend(socket, { type: "error", message: "Signal type is not allowed for this role" });
      return;
    }

    const target = this.ctx.getWebSockets().find(other => {
      if (other === socket) return false;
      const data = attachmentOf(other);
      return data.authenticated && data.clientId === targetId;
    });

    if (!target) {
      safeSend(socket, { type: "error", message: "指定的觀看端或攝影機已離線" });
      return;
    }

    const targetData = attachmentOf(target);
    if (
      (attachment.role === "camera" && targetData.role !== "viewer") ||
      (attachment.role === "viewer" && targetData.role !== "camera")
    ) {
      safeSend(socket, { type: "error", message: "Invalid signal recipient" });
      return;
    }

    safeSend(target, {
      ...message,
      from: attachment.clientId
    });
  }

  async webSocketClose(socket) {
    const attachment = attachmentOf(socket);
    if (!attachment.authenticated) return;

    const sockets = this.ctx.getWebSockets();
    if (attachment.role === "camera") {
      for (const other of sockets) {
        const data = attachmentOf(other);
        if (data.authenticated && data.role === "viewer") {
          safeSend(other, {
            type: "peer-left",
            role: "camera",
            peerId: attachment.clientId
          });
        }
      }
    } else if (attachment.role === "viewer") {
      for (const other of sockets) {
        const data = attachmentOf(other);
        if (data.authenticated && data.role === "camera") {
          safeSend(other, {
            type: "peer-left",
            role: "viewer",
            peerId: attachment.clientId
          });
        }
      }
    }
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }
}
