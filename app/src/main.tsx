import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { BackendProvider } from "./backend/context";
import "./styles.css";

// M2 picks TauriBackend inside the desktop shell and MockBackend otherwise.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BackendProvider backend={null}>
      <App />
    </BackendProvider>
  </StrictMode>,
);
