// Planning — option-pick surface (§7 Invoke family). Refactored to §6 primitives:
// StatusBlock, OptionCard, Button. Goal bar = key/value row. Three OptionCards.
// Custom input below. Footer build action = Button variant="primary" [ build ↗ ].
import { Button, OptionCard, StatusBlock } from "../components";
import { useSurface } from "../surfaceContext";

export function PlanningPanel() {
  const {
    latestUser,
    planningOptions,
    planningChoice,
    setPlanningChoice,
    planningCustom,
    setPlanningCustom,
    selectedPlanningOption,
    runPlanningBuild
  } = useSurface();

  return (
    <section className="cj-planning" aria-label="Planning mode">
      {/* Goal bar — key/value row (MetadataBlock idiom, inline here) */}
      <div className="cj-planning__goal">
        <span className="cj-planning__goal-key">GOAL</span>
        <span className="cj-planning__goal-val">
          {latestUser?.content || "summarize every product page I visit"}
        </span>
      </div>

      {/* Question line — accent ■ (StatusBlock) leads the prose */}
      <div className="cj-planning__question">
        <StatusBlock state="active" label="Question" />
        <span>How should the result appear?</span>
      </div>

      {/* Option stack — OptionCard primitives, selected carries accent ■ + border */}
      <div className="cj-planning__options">
        {planningOptions.map((option) => (
          <OptionCard
            key={option.id}
            title={option.title}
            description={option.detail}
            selected={planningChoice === option.id}
            onClick={() => setPlanningChoice(option.id)}
          />
        ))}
      </div>

      {/* Custom input — accent ■ marker mirrors the question line pattern */}
      <div className="cj-planning__custom">
        <StatusBlock state={planningCustom.trim() ? "active" : "pending"} />
        <input
          className="cj-planning__custom-input"
          value={planningCustom}
          onChange={(event) => setPlanningCustom(event.target.value)}
          placeholder="write your own…"
          aria-label="Custom planning option"
        />
      </div>

      {/* Footer — selected option label + primary build button */}
      <footer className="cj-planning__footer">
        <span className="cj-planning__footer-label">
          {selectedPlanningOption.title}
        </span>
        <Button
          variant="primary"
          type="button"
          onClick={() => void runPlanningBuild()}
          aria-label="Build with selected option"
        >
          [ build ↗ ]
        </Button>
      </footer>
    </section>
  );
}
