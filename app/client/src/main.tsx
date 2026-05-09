import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { FocusedFieldProvider } from "./focused-field";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FocusedFieldProvider>
      <App />
    </FocusedFieldProvider>
  </React.StrictMode>,
);
