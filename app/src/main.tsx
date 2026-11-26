import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createBackend } from "./backend";
import { BackendProvider } from "./backend/context";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BackendProvider backend={createBackend()}>
      <App />
    </BackendProvider>
  </StrictMode>,
);
