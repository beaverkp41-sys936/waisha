"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The platform's mark, said once under the notification bar.
 *
 * The words are the command center's `login.brand` block, so the office can rephrase the
 * line without a deploy, and an empty block means it has been switched off — the strip
 * then renders nothing rather than an empty band of glass.
 */
export function BrandLine() {
  const [text, setText] = useState("");

  useEffect(() => {
    let cancelled = false;
    const sw = /^sw/i.test(navigator.language || "");
    fetch(`${API}/api/v1/content/copy${sw ? "?lang=sw" : ""}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!cancelled && typeof j?.loginBrand === "string") setText(j.loginBrand.trim());
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  if (!text) return null;
  return (
    <p className="brand-strip">
      <span className="brand-strip-words">{text}</span>
    </p>
  );
}
