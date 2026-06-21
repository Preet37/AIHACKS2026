// §6 — full-width Pane row. One-line title (body, weight 500) + two-line
// description (dim). Selected: accent border + leading accent ■.
import { StatusBlock } from "./StatusBlock";

interface OptionCardProps {
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}

export function OptionCard({ title, description, selected, onClick }: OptionCardProps) {
  const classes = ["cj-option", selected ? "cj-option--selected" : ""].filter(Boolean).join(" ");

  return (
    <button type="button" className={classes} onClick={onClick} aria-pressed={selected}>
      <StatusBlock state={selected ? "active" : "pending"} />
      <span className="cj-option__text">
        <strong className="cj-option__title">{title}</strong>
        <small className="cj-option__desc">{description}</small>
      </span>
    </button>
  );
}
