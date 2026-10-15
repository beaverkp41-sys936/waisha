"use client";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  hint: string;
  /** A route, an action that opens the create form, or a selector to scroll to. */
  action?: { label: string; href?: string; onClick?: () => void; target?: string };
  colSpan?: number;
}

const PILL = "waisha-btn inline-block rounded-input px-20 py-10 text-sm";

export function EmptyState({ icon: Icon, title, hint, action, colSpan }: Props) {
  const jump = () => {
    const host = action?.target ? document.querySelector<HTMLElement>(action.target) : null;
    if (!host) return;
    host.scrollIntoView({ behavior: "smooth", block: "center" });
    const field = host.matches("input, select, textarea, button")
      ? host
      : host.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button");
    (field ?? host).focus({ preventScroll: true });
  };

  const body = (
    <div className="empty-state">
      <span className="empty-icon"><Icon aria-hidden strokeWidth={1.8} /></span>
      <p className="empty-title">{title}</p>
      <p className="empty-hint">{hint}</p>
      {action?.href
        ? <Link className={PILL} href={action.href}>{action.label}</Link>
        : action
          ? <button type="button" className={PILL} onClick={action.onClick ?? jump}>{action.label}</button>
          : null}
    </div>
  );

  if (colSpan === undefined) return body;
  return <tr><td colSpan={colSpan} className="p-12">{body}</td></tr>;
}
