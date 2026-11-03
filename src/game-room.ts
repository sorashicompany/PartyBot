import { DurableObject } from "cloudflare:workers";
import { verifyRoomTicket } from "./tickets";
import type { Env } from "./types";

type RoomEvent = { type: string; payload?: unknown; at: number };

export type RoomChatLine = {
  id: number;
  name: string;
  text: string;
  mine: boolean;
  at: number;
};

type ChatRow = { id: number; user_id: number; name: string; body: string; created_at: number };

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS chat_messages_scope ON chat_messages(scope, id)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_rate (
        user_id INTEGER PRIMARY KEY,
        last_at INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS audience_votes (
        round INTEGER NOT NULL,
        prompt_index INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        answer_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (round, prompt_index, user_id)
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS audience_vote_names (
        round INTEGER NOT NULL, prompt_index INTEGER NOT NULL, user_id INTEGER NOT NULL,
        answer_id TEXT NOT NULL, user_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (round, prompt_index, user_id)
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS round_question_slots (
        round INTEGER NOT NULL, user_id INTEGER NOT NULL, prompt_slot INTEGER NOT NULL,
        prompt_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (round, user_id, prompt_slot)
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS round_awards (
        round INTEGER PRIMARY KEY,
        awarded_at INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS question_reveals (
        round INTEGER NOT NULL, prompt_index INTEGER NOT NULL, revealed_at INTEGER NOT NULL,
        PRIMARY KEY (round, prompt_index)
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS question_awards (
        round INTEGER NOT NULL, prompt_index INTEGER NOT NULL, awarded_at INTEGER NOT NULL,
        PRIMARY KEY (round, prompt_index)
      )`);
    });
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
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(encoded); }
      catch { socket.close(1011, "broadcast failed"); }
    }
  }

  async listChat(scope: string, userId: number): Promise<RoomChatLine[]> {
    return this.readChat(scope, userId);
  }

  async postChat(input: { scope: string; userId: number; name: string; text: string }): Promise<{ messages: RoomChatLine[]; error?: string }> {
    const text = input.text.replace(/\s+/g, " ").trim().slice(0, 160);
    const name = input.name.replace(/\s+/g, " ").trim().slice(0, 40) || "Игрок";
    const scope = input.scope.slice(0, 40);
    if (!text || !scope) return { messages: this.readChat(scope, input.userId), error: "Пустое сообщение" };
    const now = Date.now();
    const recent = this.ctx.storage.sql.exec(
      `SELECT last_at FROM chat_rate WHERE user_id = ?`,
      input.userId,
    ).toArray() as Array<{ last_at: number }>;
    const last = Number(recent[0]?.last_at || 0);
    if (now - last < 1200) {
      return { messages: this.readChat(scope, input.userId), error: "Помедленнее, зал не успевает" };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO chat_rate (user_id, last_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_at = excluded.last_at`,
      input.userId,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO chat_messages (scope, user_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)`,
      scope,
      input.userId,
      name,
      text,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM chat_messages WHERE scope = ? AND id <= COALESCE((
        SELECT id FROM chat_messages WHERE scope = ? ORDER BY id DESC LIMIT 1 OFFSET 80
      ), 0)`,
      scope,
      scope,
    );
    const messages = this.readChat(scope, input.userId);
    await this.broadcast("chat", { scope, messages });
    return { messages };
  }

  async castAudienceVote(input: { round: number; promptIndex: number; userId: number; answerId: string; userName?: string }): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
    const existing = this.ctx.storage.sql.exec(
      `SELECT answer_id FROM audience_votes WHERE round = ? AND prompt_index = ? AND user_id = ?`,
      input.round, input.promptIndex, input.userId,
    ).toArray() as Array<{ answer_id: string }>;
    if (existing.length) return { ok: false, error: "Вы уже проголосовали за этот вопрос", counts: await this.getAudienceCounts(input.round, input.promptIndex) };
    this.ctx.storage.sql.exec(
      `INSERT INTO audience_votes (round, prompt_index, user_id, answer_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      input.round, input.promptIndex, input.userId, input.answerId, Date.now(),
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO audience_vote_names (round, prompt_index, user_id, answer_id, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      input.round, input.promptIndex, input.userId, input.answerId,
      (input.userName || "Зритель").replace(/\s+/g, " ").trim().slice(0, 80) || "Зритель", Date.now(),
    );
    const counts = await this.getAudienceCounts(input.round, input.promptIndex);
    await this.broadcast("audience_vote", { round: input.round, promptIndex: input.promptIndex, counts });
    return { ok: true, counts };
  }

  async rollbackAudienceVote(input: { round: number; promptIndex: number; userId: number }): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM audience_votes WHERE round = ? AND prompt_index = ? AND user_id = ?`,
      input.round, input.promptIndex, input.userId,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM audience_vote_names WHERE round = ? AND prompt_index = ? AND user_id = ?`,
      input.round, input.promptIndex, input.userId,
    );
    const counts = await this.getAudienceCounts(input.round, input.promptIndex);
    await this.broadcast("audience_vote", { round: input.round, promptIndex: input.promptIndex, counts });
  }

  async getAudienceVotes(round: number, promptIndex: number, userId: number): Promise<{ counts: Record<string, number>; votedAnswerId: string | null }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT answer_id FROM audience_votes WHERE round = ? AND prompt_index = ? AND user_id = ?`,
      round, promptIndex, userId,
    ).toArray() as Array<{ answer_id: string }>;
    return { counts: await this.getAudienceCounts(round, promptIndex), votedAnswerId: rows[0]?.answer_id || null };
  }

  async getAudienceVoters(round: number, promptIndex: number): Promise<Array<{ userId: number; answerId: string; userName: string }>> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT user_id, answer_id, user_name FROM audience_vote_names WHERE round = ? AND prompt_index = ? ORDER BY created_at ASC`,
      round, promptIndex,
    ).toArray() as Array<{ user_id: number; answer_id: string; user_name: string }>;
    return rows.map(row => ({ userId: Number(row.user_id), answerId: String(row.answer_id), userName: String(row.user_name) }));
  }

  async getAudienceCounts(round: number, promptIndex: number): Promise<Record<string, number>> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT answer_id, COUNT(*) AS votes FROM audience_votes WHERE round = ? AND prompt_index = ? GROUP BY answer_id`,
      round, promptIndex,
    ).toArray() as Array<{ answer_id: string; votes: number }>;
    return Object.fromEntries(rows.map(row => [String(row.answer_id), Number(row.votes)]));
  }

  async saveRoundQuestion(input: { round: number; userId: number; promptId: string; promptSlot?: number }): Promise<void> {
    const slot = Math.max(1, Math.min(2, Math.trunc(input.promptSlot || 1)));
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO round_question_slots (round, user_id, prompt_slot, prompt_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      input.round, input.userId, slot, input.promptId, Date.now(),
    );
  }

  async getRoundQuestions(round: number): Promise<Array<{ userId: number; promptId: string; promptSlot: number }>> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT user_id, prompt_id, prompt_slot FROM round_question_slots WHERE round = ? ORDER BY created_at ASC`, round,
    ).toArray() as Array<{ user_id: number; prompt_id: string; prompt_slot: number }>;
    return rows.map(row => ({ userId: Number(row.user_id), promptId: String(row.prompt_id), promptSlot: Number(row.prompt_slot) }));
  }

  async claimQuestionReveal(round: number, promptIndex: number): Promise<boolean> {
    const existing = this.ctx.storage.sql.exec(
      `SELECT round FROM question_reveals WHERE round = ? AND prompt_index = ?`,
      round, promptIndex,
    ).toArray();
    if (existing.length) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO question_reveals (round, prompt_index, revealed_at) VALUES (?, ?, ?)`,
      round, promptIndex, Date.now(),
    );
    return true;
  }

  async claimQuestionAward(round: number, promptIndex: number): Promise<boolean> {
    const existing = this.ctx.storage.sql.exec(
      `SELECT round FROM question_awards WHERE round = ? AND prompt_index = ?`,
      round, promptIndex,
    ).toArray();
    if (existing.length) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO question_awards (round, prompt_index, awarded_at) VALUES (?, ?, ?)`,
      round, promptIndex, Date.now(),
    );
    return true;
  }

  async rollbackQuestionAward(round: number, promptIndex: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM question_awards WHERE round = ? AND prompt_index = ?`,
      round, promptIndex,
    );
  }

  async claimRoundAward(round: number): Promise<boolean> {
    const existing = this.ctx.storage.sql.exec(
      `SELECT round FROM round_awards WHERE round = ?`,
      round,
    ).toArray();
    if (existing.length) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO round_awards (round, awarded_at) VALUES (?, ?)`,
      round,
      Date.now(),
    );
    return true;
  }

  private readChat(scope: string, userId: number): RoomChatLine[] {
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, user_id, name, body, created_at FROM chat_messages WHERE scope = ? ORDER BY id ASC LIMIT 80`,
      scope,
    ).toArray() as ChatRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      text: String(row.body),
      mine: Number(row.user_id) === userId,
      at: Number(row.created_at),
    }));
  }
}
