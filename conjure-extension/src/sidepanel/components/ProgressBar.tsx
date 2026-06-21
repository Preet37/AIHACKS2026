// §6 — 2px track, accent fill, paired with an n/total readout in micro.
// The only allowed progress indicator; never a round spinner.

interface ProgressBarProps {
  value: number;
  total: number;
  className?: string;
}

export function ProgressBar({ value, total, className }: ProgressBarProps) {
  const safeTotal = Math.max(total, 1);
  const percent = Math.max(0, Math.min(100, Math.round((value / safeTotal) * 100)));
  const classes = ["cj-progress", className || ""].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-valuenow={value}
    >
      <span className="cj-progress__count">
        {value}/{safeTotal}
      </span>
      <div className="cj-progress__track">
        <span className="cj-progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
