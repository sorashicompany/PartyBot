import type { Env } from "./types";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function createRoomTicket(env: Env, code: string, userId: number): Promise<string> {
  if (!env.ROOM_TICKET_SECRET) throw new Error("Room ticket secret is not configured");
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ code, userId, exp: Math.floor(Date.now() / 1000) + 3600 })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.ROOM_TICKET_SECRET, ["sign"]), new TextEncoder().encode(payload)));
  return payload + "." + toBase64Url(signature);
}

export async function verifyRoomTicket(secret: string, ticket: string, expectedCode: string): Promise<{ userId: number } | null> {
  if (!secret) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const signature = new Uint8Array(fromBase64Url(parts[1])).buffer;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), signature, new TextEncoder().encode(parts[0]));
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as { code: string; userId: number; exp: number };
    if (payload.code !== expectedCode || !Number.isSafeInteger(payload.userId) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
