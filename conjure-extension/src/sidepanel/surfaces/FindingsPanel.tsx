// Finder results surface (view-only). Renders the cards the off-device
// browser agent returned for a "find on this page" request, plus the
// Browserbase replay link. All state/behavior lives in useFinder; this file
// consumes the finder slice from surfaceContext and composes §6 primitives.
import { AlertTriangle, ExternalLink, ImageOff, PlayCircle } from "lucide-react";
import { Pane, StatusBlock } from "../components";
import { useSurface } from "../surfaceContext";
import "./FindingsPanel.css";

export function FindingsPanel() {
  const { finder } = useSurface();
  const { status, findings, error, replayUrl } = finder;

  // Idle = the feature has never run this session; stay out of the layout.
  if (status === "idle") return null;

  const headLabel =
    status === "running" ? "searching" : status === "error" ? "error" : `${findings.length} found`;

  return (
    <Pane
      name="FINDS"
      ariaLabel="Find on this page results"
      bodyClassName="fp-body"
      headerRight={
        <span className="fp-count">
          <StatusBlock state={status === "running" ? "active" : "done"} pulse={status === "running"} />
          {headLabel}
        </span>
      }
    >
      {status === "running" ? (
        <p className="fp-empty">Spinning up a cloud browser to search…</p>
      ) : null}

      {status === "error" && error ? (
        <div className="fp-error">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {status === "done" && findings.length === 0 ? (
        <p className="fp-empty">No matching items found on this page.</p>
      ) : null}

      {findings.length ? (
        <ul className="fp-list">
          {findings.map((finding, index) => (
            <li key={`${finding.url}-${index}`} className="fp-card">
              <a
                className="fp-card-link"
                href={finding.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${finding.title}`}
              >
                <span className="fp-thumb">
                  {finding.image ? (
                    <img src={finding.image} alt="" loading="lazy" />
                  ) : (
                    <ImageOff aria-hidden="true" />
                  )}
                </span>
                <span className="fp-info">
                  <span className="fp-title">
                    {finding.title}
                    <ExternalLink aria-hidden="true" />
                  </span>
                  {finding.price ? <span className="fp-price">{finding.price}</span> : null}
                  {finding.note ? <span className="fp-note">{finding.note}</span> : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {replayUrl ? (
        <a className="fp-replay" href={replayUrl} target="_blank" rel="noreferrer">
          <PlayCircle aria-hidden="true" />
          Watch the agent
        </a>
      ) : null}
    </Pane>
  );
}
