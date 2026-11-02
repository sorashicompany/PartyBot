import { GameRoom } from "./game-room";
import { handleTelegramUpdate } from "./telegram";
import { supabaseRequest } from "./supabase";
import { createRoomTicket } from "./tickets";
import type { Env, TelegramUpdate } from "./types";

export { GameRoom };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data"
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      if (url.pathname === "/health") return Response.json({ ok: true, name: "SorashiPartyFunBot" });

      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (!secret || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("Unauthorized", { status: 401 });
        const update = await request.json() as TelegramUpdate;
        ctx.waitUntil(handleTelegramUpdate(env, update));
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/rooms/join" && request.method === "POST") {
        const user = await authenticateMiniApp(request, env.BOT_TOKEN).catch(() => null);
        if (!user) return Response.json({ error: "Unauthorized Telegram session" }, { status: 401, headers: corsHeaders });
        const body = await request.json() as { code?: string };
        const code = (body.code || "").toUpperCase();
        if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return Response.json({ error: "Invalid room code" }, { status: 400, headers: corsHeaders });

        const rooms = await supabaseRequest<Array<{ id: string; code: string; status: string }>>(env, `rooms?code=eq.${code}&select=id,code,status&limit=1`);
        const room = rooms[0];
        if (!room || ["finished", "cancelled"].includes(room.status)) return Response.json({ error: "Room not found or closed" }, { status: 404, headers: corsHeaders });

        const players = await supabaseRequest<Array<{ telegram_user_id: number }>>(env, `room_players?room_id=eq.${room.id}&select=telegram_user_id`);
        if (!players.some(p => Number(p.telegram_user_id) === user.id)) {
          if (room.status !== "lobby") return Response.json({ error: "Game already started" }, { status: 409, headers: corsHeaders });
          if (players.length >= 10) return Response.json({ error: "Room is full" }, { status: 409, headers: corsHeaders });
          const name = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 80) || "Player";
          await supabaseRequest(env, "room_players", { method: "POST", body: JSON.stringify({ room_id: room.id, telegram_user_id: user.id, display_name: name }) });
        }
        const ticket = await createRoomTicket(env, room.code, user.id);
        const stub = env.GAME_ROOMS.getByName(room.code);
        await stub.broadcast("room_changed", { code: room.code });
        return Response.json({ ok: true, code: room.code, ticket }, { headers: corsHeaders });
      }

      if (url.pathname.startsWith("/ws/rooms/")) {
        const code = url.pathname.split("/").pop()?.toUpperCase() || "";
        if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return new Response("Invalid room code", { status: 400 });
        const stub = env.GAME_ROOMS.getByName(code);
        return stub.fetch(request);
      }

      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not implemented" }, { status: 404, headers: corsHeaders });
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : "unknown" }));
      return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
    }
  }
};

async function authenticateMiniApp(request: Request, botToken: string): Promise<{ id: number; first_name: string; last_name?: string }> {
  const initData = request.headers.get("X-Telegram-Init-Data") || "";
  if (!initData || initData.length > 8192) throw new Error("Missing Telegram initData");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Invalid Telegram initData");
  params.delete("hash");
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const encoder = new TextEncoder();
  const webAppKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secretKey = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(checkString)));
  const actualHash = [...signature].map(b => b.toString(16).padStart(2, "0")).join("");
  if (!constantTimeHexEqual(actualHash, receivedHash)) throw new Error("Telegram initData signature mismatch");
  const authDate = Number(params.get("auth_date") || 0);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!authDate || ageSeconds > 3600 || ageSeconds < -60) throw new Error("Telegram initData expired");
  const rawUser = params.get("user");
  if (!rawUser) throw new Error("Telegram user missing");
  const user = JSON.parse(rawUser) as { id?: number; first_name?: string; last_name?: string };
  if (!Number.isSafeInteger(user.id) || !user.first_name) throw new Error("Invalid Telegram user");
  return { id: user.id as number, first_name: user.first_name, last_name: user.last_name };
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function timingSafeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
