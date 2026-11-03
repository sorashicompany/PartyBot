import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MiniApp } from "./components/party/mini-app";
import "./styles.css";

type TelegramWebApp = {
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  onEvent?(event: string, callback: () => void): void;
  offEvent?(event: string, callback: () => void): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  initData?: string;
  colorScheme?: "light" | "dark";
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function syncTelegramViewport(app?: TelegramWebApp) {
  if (!app || typeof document === "undefined") return;
  const root = document.documentElement;
  const height = app.viewportStableHeight || app.viewportHeight;
  if (height && Number.isFinite(height)) root.style.setProperty("--tg-viewport-height", `${height}px`);
  const safe = app.safeAreaInset;
  const content = app.contentSafeAreaInset;
  if (safe) {
    root.style.setProperty("--tg-safe-top", `${safe.top}px`);
    root.style.setProperty("--tg-safe-bottom", `${safe.bottom}px`);
  }
  if (content) {
    root.style.setProperty("--tg-content-safe-top", `${content.top}px`);
    root.style.setProperty("--tg-content-safe-bottom", `${content.bottom}px`);
  }
}

function TelegramLifecycle() {
  useEffect(() => {
    const app = window.Telegram?.WebApp;
    if (!app) return;
    app.ready();
    app.expand();
    app.disableVerticalSwipes?.();
    app.setHeaderColor?.("#100c18");
    app.setBackgroundColor?.("#100c18");
    app.setBottomBarColor?.("#100c18");
    const sync = () => syncTelegramViewport(app);
    sync();
    app.onEvent?.("viewportChanged", sync);
    app.onEvent?.("safeAreaChanged", sync);
    app.onEvent?.("contentSafeAreaChanged", sync);
    window.addEventListener("resize", sync);
    return () => {
      app.offEvent?.("viewportChanged", sync);
      app.offEvent?.("safeAreaChanged", sync);
      app.offEvent?.("contentSafeAreaChanged", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);
  return null;
}

const telegramApp = window.Telegram?.WebApp;
const initData = telegramApp?.initData || "";
const user = telegramApp?.initDataUnsafe?.user;
const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
const startCode = (telegramApp?.initDataUnsafe?.start_param || new URLSearchParams(window.location.search).get("startapp") || "").toUpperCase();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TelegramLifecycle />
    <MiniApp initData={initData} startCode={startCode} displayName={displayName} />
  </React.StrictMode>,
);
