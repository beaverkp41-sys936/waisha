async function getFooter() {
  const api = process.env.API_ORIGIN ?? "http://localhost:4000";
  try {
    const res = await fetch(`${api}/api/v1/content/footer`, { next: { revalidate: 300 } });
    if (res.ok) return await res.json();
  } catch {}
  return { brand: "T ENGO AEGIS", supportEmail: "support@tengoaegis.com", phone: "" };
}

export async function Footer() {
  const f = await getFooter();
  return (
    <footer
      className="w-full py-16 text-center text-[13px] tracking-[0.04em] text-white"
      style={{ background: "var(--brand-deep)" }}
    >
      {f.brand} | {f.supportEmail} | mob. {f.phone}
    </footer>
  );
}