import React from "react";
import { createRoot } from "react-dom/client";
import { PartyShow } from "./components/party/show";
import "./styles.css";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready(): void;
        expand(): void;
        disableVerticalSwipes?(): void;
        setHeaderColor?(color: string): void;
        setBackgroundColor?(color: string): void;
        initData?: string;
        colorScheme?: "light" | "dark";
        isExpanded?: boolean;
        viewportStableHeight?: number;
      };
    };
  }
}

const telegram = window.Telegram?.WebApp;
telegram?.ready();
telegram?.expand();
telegram?.disableVerticalSwipes?.();
telegram?.setHeaderColor?.("#100c18");
telegram?.setBackgroundColor?.("#100c18");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PartyShow />
  </React.StrictMode>,
);