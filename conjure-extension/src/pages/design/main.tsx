import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadExtensionFonts } from "../../shared/fonts";
import { StatusBar } from "../../sidepanel/components";
import { SurfaceProvider } from "../../sidepanel/surfaceContext";
import { DesignPanel } from "../../sidepanel/surfaces/DesignPanel";
import { DesignStage } from "../../sidepanel/surfaces/DesignStage";
import { createStaticSurfaceValue, defaultUiSettings } from "../shared/staticSurface";
import "../../sidepanel/tokens.css";
import "../../sidepanel/styles.css";
import "../../sidepanel/components/primitives.css";
import "../../sidepanel/surfaces/Design.css";
import "../shared/page.css";

loadExtensionFonts();

function DesignPage() {
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
        setProjectId,
        activeTab: {
          id: 0,
          title: "Active page",
          url: "extension tab",
          active: true
        }
      }),
    [projectId, uiSettings]
  );

  return (
    <SurfaceProvider value={surface}>
      <main className="cj-page">
        <StatusBar
          workspaces={[{ id: "design", label: "design" }]}
          activeId="design"
          onSelect={() => undefined}
          right={<span className="cj-statusbar__status">design tab</span>}
        />
        <section className="cj-page__split" aria-label="Design workspace">
          <div className="cj-page__stage">
            <DesignStage />
          </div>
          <aside className="cj-page__panel">
            <DesignPanel />
          </aside>
        </section>
      </main>
    </SurfaceProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DesignPage />
  </React.StrictMode>
);
