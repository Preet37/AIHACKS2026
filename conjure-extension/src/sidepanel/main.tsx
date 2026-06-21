import React from "react";
import { createRoot } from "react-dom/client";
import { loadExtensionFonts } from "../shared/fonts";
import App from "./App";
import "./tokens.css";
import "./styles.css";
import "./components/primitives.css";

loadExtensionFonts();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
