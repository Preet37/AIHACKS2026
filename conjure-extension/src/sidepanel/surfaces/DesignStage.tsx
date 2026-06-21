import { SelectionOverlay } from "../components";
import { useSurface } from "../surfaceContext";
import "./Design.css";

export function DesignStage() {
  const { activeTab } = useSurface();

  return (
    <div className="ds-canvas" aria-label="Selected page preview">
      <div className="ds-canvas__grid" aria-hidden="true" />

      <header className="ds-canvas__bar">
        <span>CONJURE</span>
        <span className="ds-canvas__bar-title">design mode</span>
      </header>

      <div className="ds-canvas__body">
        <section className="ds-mock-page" aria-label={activeTab?.title || "User profile"}>
          <h2 className="ds-mock-page__title">User Profile</h2>
          <p className="ds-canvas__desc">
            Review the activity and current status of the selected user entity. Ensure all
            parameters align with operational requirements before initiating follow up
            sequences.
          </p>

          <div className="ds-canvas__selection-wrap">
            <SelectionOverlay>
              <button type="button" className="ds-canvas__btn">
                Follow up
              </button>
            </SelectionOverlay>
          </div>
        </section>
      </div>
    </div>
  );
}
