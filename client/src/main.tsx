import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { StringsProvider } from "./lib/stringsContext.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StringsProvider>
      <App />
    </StringsProvider>
  </StrictMode>
);
