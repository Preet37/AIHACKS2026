import { MetadataBlock } from "../components";
import type { MetaRow } from "../components";
import { useSurface } from "../surfaceContext";

export function TracePanel() {
  const {
    latestUser,
    providerLabel,
    elapsedLabel,
    completedTraceCount,
    traceEntries,
    activeScope,
    sandboxImageSrc
  } = useSurface();

  const metaRows: MetaRow[] = [
    { key: "RUN", value: latestUser?.content || "idle" },
    { key: "AGENT", value: providerLabel },
    { key: "ELAPSED", value: elapsedLabel },
    {
      key: "STEP",
      value: `${completedTraceCount} / ${Math.max(traceEntries.length, 1)}`
    },
    { key: "SCOPE", value: activeScope }
  ];

  return (
    <section className="tp-panel" aria-label="Run metadata">
      <header className="tp-panel__head">metadata</header>
      <div className="tp-panel__body">
        <div className="tp-meta">
          <MetadataBlock rows={metaRows} />
        </div>

        {sandboxImageSrc ? (
          <figure className="tp-sandbox">
            <img
              src={sandboxImageSrc}
              alt="Latest sandbox verification screenshot"
              className="tp-sandbox__img"
            />
            <figcaption className="tp-sandbox__caption">latest sandbox frame</figcaption>
          </figure>
        ) : null}
      </div>
    </section>
  );
}
