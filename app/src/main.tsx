import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";

// The crate spike (DWX-20), in development builds only. Imported only behind
// import.meta.env.DEV, so a release build has none of it.
const CrateSpikeHost = import.meta.env.DEV
  ? lazy(() => import("./crate-spike/CrateSpikeHost"))
  : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {CrateSpikeHost && (
      <Suspense fallback={null}>
        <CrateSpikeHost />
      </Suspense>
    )}
  </React.StrictMode>,
);
