import { DurableObject } from "cloudflare:workers";
import { verifyRoomTicket } from "./tickets";
import type { Env } from "./types";

type RoomEvent = { type: string; payload?: unknown; at: number };

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.pathname.split("/").pop()?.toUpperCase() || "";
    const ticket = url.searchParams.get("ticket") || "";
    if (!ticket || !(await verifyRoomTicket(this.env.ROOM_TICKET_SECRET, ticket, code))) {
      return Response.json({ error: "Unauthorized room connection" }, { status: 401 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
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

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 1024) return;
    let parsed: { type?: string };
    try { parsed = JSON.parse(message) as { type?: string }; } catch { return; }
    if (parsed.type === "ping") socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
  }

  async broadcast(event: string, payload: unknown): Promise<void> {
    const message: RoomEvent = { type: event, payload, at: Date.now() };
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(JSON.stringify(message)); }
      catch { socket.close(1011, "broadcast failed"); }
    }
  }
}
