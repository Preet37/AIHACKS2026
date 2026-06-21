import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StatusBar, StatusBlock } from "../../sidepanel/components";
import { SurfaceProvider } from "../../sidepanel/surfaceContext";
import { TracePanel } from "../../sidepanel/surfaces/TracePanel";
import { TraceStage } from "../../sidepanel/surfaces/TraceStage";
import { createStaticSurfaceValue, defaultUiSettings } from "../shared/staticSurface";
import "../../sidepanel/tokens.css";
import "../../sidepanel/styles.css";
import "../../sidepanel/components/primitives.css";
import "../../sidepanel/surfaces/Trace.css";
import "../shared/page.css";

function RunPage() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [uiSettings, setUiSettings] = useState(defaultUiSettings);
  const [projectId, setProjectId] = useState("local-demo");
  const surface = useMemo(
    () =>
      createStaticSurfaceValue({
        messagesEndRef,
        uiSettings,
        setUiSettings,
        projectId,
        setProjectId
      }),
    [projectId, uiSettings]
  );

  return (
    <SurfaceProvider value={surface}>
      <main className="cj-page">
        <StatusBar
          workspaces={[{ id: "track", label: "track" }]}
          activeId="track"
          onSelect={() => undefined}
          right={
            <>
              <StatusBlock state="pending" label="idle" />
              <span className="cj-statusbar__status">run trace</span>
            </>
          }
        />
        <section className="cj-page__split" aria-label="Run trace">
          <div className="cj-page__stage">
            <TraceStage />
          </div>
          <aside className="cj-page__panel">
            <TracePanel />
          </aside>
        </section>
      </main>
    </SurfaceProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RunPage />
  </React.StrictMode>
);
