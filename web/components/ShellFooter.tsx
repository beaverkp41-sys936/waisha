"use client";
import { useEffect, useState } from "react";
import { FooterBar, normalizeFooter, type FooterContent } from "@/components/FooterBar";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/* The shell footer is client-side because the app layout is a client component
   and cannot render the server Footer inside its own scroll container.

   It is also the half that can ask for the caller's own language: a server component
   that read Accept-Language would cost the marketing pages their cached render, and a
   footer is not worth that. Here the browser already knows, so the portal asks for
   Kiswahili when the visitor's device says so and takes English otherwise. */
export function ShellFooter() {
  const [content, setContent] = useState<FooterContent>(() => normalizeFooter(null));

  useEffect(() => {
    let cancelled = false;
    const sw = /^sw/i.test(navigator.language || "");
    fetch(`${API}/api/v1/content/footer${sw ? "?lang=sw" : ""}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && !cancelled) setContent(normalizeFooter(j)); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  return <FooterBar content={content} />;
}
