"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const FALLBACK = {
  brand: "powered by T ENGO AEGIS",
  supportEmail: "support@tengoaegis.com",
  phone: "+255 717 601 440 / +255 754 000 440"
};

/* The shell footer is client-side because the app layout is a client component
   and cannot render the server Footer inside its own scroll container. */
export function ShellFooter() {
  const [f, setF] = useState(FALLBACK);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/v1/content/footer`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && !cancelled) setF(j); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);
  return (
    <footer
      className="app-footer w-full py-16 text-center text-[13px] tracking-[0.04em] text-white"
      style={{ background: "var(--navy-deep)", borderTop: "1px solid rgba(255,255,255,0.18)" }}
    >
      {f.brand} | {f.supportEmail} | mob. {f.phone}
    </footer>
  );
}
