import React from "react";
import { createRoot } from "react-dom/client";
import { RuntimeApp } from "./RuntimeApp.tsx";
import "./styles/tokens.css";
import "./styles/reset.css";
import "./styles/globals.css";
import "./styles/motion.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (import.meta.env.DEV && location.pathname === "/__ui-gallery") {
  void import("./dev/UiGallery.tsx").then(({ UiGallery }) => {
    root.render(<React.StrictMode><UiGallery /></React.StrictMode>);
  }, () => {
    root.render(<main role="alert">UI Gallery 加载失败，请刷新页面。</main>);
  });
} else {
  root.render(<React.StrictMode><RuntimeApp /></React.StrictMode>);
}
