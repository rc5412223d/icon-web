export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "PocketCam signaling", version: 1 });
    }
    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const roomId = decodeURIComponent(url.pathname.slice(4));
      if (!/^[a-f0-9-]{16,64}$/i.test(roomId)) {
        return new Response("Invalid room id", { status: 400 });
      }
      const id = env.ROOMS.idFromName(roomId);
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

    const attachment = socket.deserializeAttachment() || {};
    if (!attachment.authenticated) {
      if (message.type !== "hello" || !["camera", "viewer"].includes(message.role)) {
        socket.send(JSON.stringify({ type: "error", message: "Authentication required" }));
        socket.close(1008, "Authentication required");
        return;
      }
      const pin = String(message.pin || "");
      if (!/^\d{6}$/.test(pin)) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid pairing code" }));
        socket.close(1008, "Invalid pairing code");
        return;
      }

      const sockets = this.ctx.getWebSockets();
      const roleTaken = sockets.some(other => {
        if (other === socket) return false;
        const data = other.deserializeAttachment() || {};
        return data.authenticated && data.role === message.role;
      });
      if (roleTaken) {
        socket.send(JSON.stringify({ type: "error", message: "This role is already connected" }));
        socket.close(1008, "Role already connected");
        return;
      }

      if (message.role === "camera") {
        await this.ctx.storage.put("pin", pin);
      } else {
        const savedPin = await this.ctx.storage.get("pin");
        if (!savedPin || savedPin !== pin) {
          socket.send(JSON.stringify({ type: "error", message: "Pairing code does not match" }));
          socket.close(1008, "Pairing code mismatch");
          return;
        }
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
