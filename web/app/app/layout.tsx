import Link from "next/link";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: "var(--milk)" }}>
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)" }}>
        <div className="flex items-center gap-24">
          <span className="text-sm font-bold tracking-[0.08em] text-white">WAISHA</span>
          <nav className="flex gap-16 text-xs font-semibold">
            <Link href="/app/profile" className="underline" style={{ color: "var(--gold)" }}>Profile</Link>
            <Link href="/app/branches" className="underline" style={{ color: "var(--gold)" }}>Branches</Link>
            <Link href="/app/fleet" className="underline" style={{ color: "var(--gold)" }}>Fleet</Link>
            <Link href="/app/routes" className="underline" style={{ color: "var(--gold)" }}>Routes</Link>
            <Link href="/post-login" className="underline" style={{ color: "var(--gold)" }}>Account</Link>
          </nav>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "rgba(255,255,255,0.6)" }}>
          Transporter portal
        </span>
      </header>
      <main>{children}</main>
    </div>
  );
}