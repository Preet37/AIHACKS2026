// Manipulate — Design mode inspector (§7).
// Composed from §6 primitives: Window (hairline WM title bar + text ✕),
// MetadataBlock (label / width / height readonly rows), an indigo-family
// swatch row, a 1px slider, and a Button for the run-agent action.
// XCircle (round lucide icon) replaced by Window's built-in text ✕.
// "none" swatch diagonal uses var(--cj-faint), not any second hue.
import { Window, MetadataBlock, Button } from "../components";
import { useSurface } from "../surfaceContext";

export function DesignPanel() {
  const { editingMod, setMode, providerLabel } = useSurface();

  const label = editingMod?.prompt || "Follow up";

  return (
    <Window
      title="inspector — button"
      onClose={() => setMode("home")}
      ariaLabel="Design mode inspector"
      bodyClassName="ds-inspector"
    >
      {/* readonly field rows via MetadataBlock */}
      <MetadataBlock
        rows={[
          { key: "LABEL", value: label },
          { key: "WIDTH", value: "Auto" },
          { key: "HEIGHT", value: "48 px" }
        ]}
      />

      {/* fill swatches — indigo family + grounds only; one accent; no second hue */}
      <div className="ds-field">
        <span className="ds-field-key">FILL</span>
        <div className="ds-swatches" role="group" aria-label="Fill color">
          {/* none / no fill — dim diagonal, NOT red */}
          <button
            type="button"
            className="ds-swatch ds-swatch--none"
            title="No fill"
            aria-label="No fill"
          />
          {/* grounds + surfaces */}
          <button
            type="button"
            className="ds-swatch"
            title="Ground"
            aria-label="Ground"
            style={{ background: "var(--cj-ground)" }}
          />
          <button
            type="button"
            className="ds-swatch"
            title="Surface"
            aria-label="Surface"
            style={{ background: "var(--cj-surface)" }}
          />
          <button
            type="button"
            className="ds-swatch"
            title="Surface 2"
            aria-label="Surface 2"
            style={{ background: "var(--cj-surface-2)" }}
          />
          {/* text + dim */}
          <button
            type="button"
            className="ds-swatch"
            title="Dim"
            aria-label="Dim"
            style={{ background: "var(--cj-dim)" }}
          />
          <button
            type="button"
            className="ds-swatch"
            title="Text"
            aria-label="Text"
            style={{ background: "var(--cj-text)" }}
          />
          {/* accent — selected */}
          <button
            type="button"
            className="ds-swatch ds-swatch--selected"
            title="Accent"
            aria-label="Accent (selected)"
            style={{ background: "var(--cj-accent)" }}
          />
        </div>
      </div>

      {/* 1px slider — track var(--cj-line), fill var(--cj-accent) */}
      <div className="ds-field">
        <span className="ds-field-key">PADDING</span>
        <div
          className="ds-slider-row"
          role="presentation"
          aria-label="Padding 24 px"
        >
          <span style={{ color: "var(--cj-faint)", fontSize: "var(--cj-fs-micro)" }}>0</span>
          <div className="ds-slider-track" aria-hidden="true">
            <span className="ds-slider-fill" style={{ width: "42%" }} />
            <span className="ds-slider-thumb" style={{ left: "calc(42% - 3px)" }} />
          </div>
          <span>24 px</span>
        </div>
      </div>

      {/* run-agent action button — sentence case label, accent border = primary */}
      <div className="ds-field">
        <span className="ds-field-key">ONCLICK</span>
        <Button
          variant="primary"
          onClick={() => setMode("trace")}
          style={{ justifyContent: "flex-start" }}
        >
          {`> run agent: ${providerLabel.toLowerCase()}`}
        </Button>
      </div>
    </Window>
  );
}
