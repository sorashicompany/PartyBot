export interface Env {
  GAME_ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ROOM_TICKET_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: TelegramUser;
    text?: string;
  };
}

export interface GameRoom {
  fetch(request: Request): Promise<Response>;
  broadcast(event: string, payload: unknown): Promise<void>;
}
