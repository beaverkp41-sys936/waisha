import { FooterBar, normalizeFooter } from "@/components/FooterBar";

async function getFooter() {
  const api = process.env.API_ORIGIN ?? "http://localhost:4000";
  try {
    const res = await fetch(`${api}/api/v1/content/footer`, { next: { revalidate: 300 } });
    if (res.ok) return normalizeFooter(await res.json());
  } catch {}
  return normalizeFooter(null);
}

export async function Footer() {
  const f = await getFooter();
  return <FooterBar content={f} />;
}
