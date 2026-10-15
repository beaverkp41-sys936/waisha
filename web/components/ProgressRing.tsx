interface Props {
  /** 0-100 */
  value: number;
  size?: number;
  label?: string;
}

/** Completion ring — the arc is driven by dashoffset so it animates on change. */
export function ProgressRing({ value, size = 84, label = "%" }: Props) {
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      role="img" aria-label={`${pct}${label}`} style={{ flex: "0 0 auto" }}>
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r}
        fill="none" strokeWidth={stroke} />
      <circle className="ring-value" cx={size / 2} cy={size / 2} r={r}
        fill="none" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        fill="currentColor" fontSize={size * 0.24} fontWeight={700}>
        {pct}{label}
      </text>
    </svg>
  );
}
