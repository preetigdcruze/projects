export function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <rect width="512" height="512" rx="112" fill="hsl(var(--primary))" />
      <g fill="none" stroke="hsl(var(--primary-foreground))" strokeWidth="26" strokeLinecap="round">
        <path d="M256 400V230" /><path d="M256 300c-52 0-84-34-84-82 52 0 84 30 84 82Z" fill="hsl(var(--primary-foreground))" />
        <path d="M256 260c0-52 32-86 84-86 0 52-32 86-84 86Z" fill="#E5683F" stroke="#E5683F" />
      </g>
    </svg>
  );
}
