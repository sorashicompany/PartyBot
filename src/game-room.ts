import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

type RoomEvent = { type: string; payload?: unknown; at: number };

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "connected", at: Date.now() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 4096) return;
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(message) as { type?: string };
    } catch {
      return;
    }
    // Client messages are deliberately not allowed to mutate game state yet.
    // All answer/vote mutations will be implemented as authenticated server actions.
    if (parsed.type === "ping") {
      _socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
  }

  async broadcast(event: string, payload: unknown): Promise<void> {
    const message: RoomEvent = { type: event, payload, at: Date.now() };
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(JSON.stringify(message)); } catch { socket.close(1011, "broadcast failed"); }
    }
  }
}
