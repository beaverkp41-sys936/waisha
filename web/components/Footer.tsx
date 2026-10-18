import { FooterBar } from "@/components/FooterBar";

async function getFooter() {
  const api = process.env.API_ORIGIN ?? "http://localhost:4000";
  try {
    const res = await fetch(`${api}/api/v1/content/footer`, { next: { revalidate: 300 } });
    if (res.ok) return await res.json();
  } catch {}
  return { brand: "powered by T ENGO AEGIS", supportEmail: "support@tengoaegis.com", phone: "+255 717 601 440 / +255 754 000 440" };
}

export async function Footer() {
  const f = await getFooter();
  return <FooterBar {...f} />;
}
