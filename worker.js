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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "PocketCam signaling",
        version: 2,
        passwordConfigured: Boolean(env.POCKETCAM_PASSWORD)
      });
    }

    if (url.pathname === "/ws") {
      if (!env.POCKETCAM_PASSWORD) {
        return new Response("PocketCam password is not configured on this Worker.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      // All clients join one private room; the room identifier is no longer exposed.
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
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (message.type === "ping") {
      try { socket.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }

    const attachment = socket.deserializeAttachment() || {};

    if (!attachment.authenticated) {
      if (message.type !== "hello" || !["camera", "viewer"].includes(message.role)) {
        socket.send(JSON.stringify({ type: "error", message: "Authentication required" }));
        socket.close(1008, "Authentication required");
        return;
      }

      const expectedPassword = this.env.POCKETCAM_PASSWORD || "";
      const suppliedPassword = String(message.password || "");
      if (!expectedPassword || !constantTimeEqual(suppliedPassword, expectedPassword)) {
        socket.send(JSON.stringify({ type: "error", message: "連線密碼錯誤，或 Worker 尚未設定密碼" }));
        socket.close(1008, "Password rejected");
        return;
      }

      // Allow exactly one camera and one viewer in this single-device setup.
      const sockets = this.ctx.getWebSockets();
      const roleTaken = sockets.some(other => {
        if (other === socket) return false;
        const data = other.deserializeAttachment() || {};
        return data.authenticated && data.role === message.role;
      });

      if (roleTaken) {
        socket.send(JSON.stringify({ type: "error", message: "這個角色已經有裝置連線" }));
        socket.close(1008, "Role already connected");
        return;
      }

      socket.serializeAttachment({ authenticated: true, role: message.role });
      socket.send(JSON.stringify({ type: "authenticated", role: message.role }));

      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const data = other.deserializeAttachment() || {};
        if (data.authenticated) {
          other.send(JSON.stringify({ type: "peer-ready", role: message.role }));
          socket.send(JSON.stringify({ type: "peer-ready", role: data.role }));
        }
      }
      return;
    }

    if (!["offer", "answer", "candidate", "hangup"].includes(message.type)) return;

    for (const other of this.ctx.getWebSockets()) {
      if (other === socket) continue;
      const data = other.deserializeAttachment() || {};
      if (data.authenticated) {
        other.send(JSON.stringify({ ...message, from: attachment.role }));
      }
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment() || {};
    for (const other of this.ctx.getWebSockets()) {
      if (other === socket) continue;
      const data = other.deserializeAttachment() || {};
      if (data.authenticated) {
        other.send(JSON.stringify({ type: "peer-left", role: attachment.role || "peer" }));
      }
    }
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }
}
