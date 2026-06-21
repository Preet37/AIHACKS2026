import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StatusBar } from "../../sidepanel/components";
import { SurfaceProvider } from "../../sidepanel/surfaceContext";
import { SettingsPanel } from "../../sidepanel/surfaces/SettingsPanel";
import { createStaticSurfaceValue, defaultUiSettings } from "../shared/staticSurface";
import "../../sidepanel/tokens.css";
import "../../sidepanel/styles.css";
import "../../sidepanel/components/primitives.css";
import "../../sidepanel/surfaces/Settings.css";
import "../shared/page.css";

function SettingsPage() {
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
          workspaces={[{ id: "settings", label: "settings" }]}
          activeId="settings"
          onSelect={() => undefined}
          right={<span className="cj-statusbar__status">options</span>}
        />
        <section className="cj-page__settings" aria-label="Settings">
          <SettingsPanel />
        </section>
      </main>
    </SurfaceProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>
);
