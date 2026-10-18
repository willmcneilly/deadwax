import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CrateSpikeHost from "./crate-spike/CrateSpikeHost";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {import.meta.env.DEV && <CrateSpikeHost />}
  </React.StrictMode>,
);
