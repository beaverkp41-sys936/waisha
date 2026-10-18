import { WeatherStrip } from "@/components/WeatherStrip";

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
  return (
    <footer className="app-footer w-full py-12 text-[13px] tracking-[0.04em] text-white">
      <div className="flex flex-col items-center gap-8 px-20 sm:flex-row sm:justify-between sm:gap-x-20">
        <span className="text-center sm:text-left">{f.brand} | {f.supportEmail} | mob. {f.phone}</span>
        <WeatherStrip />
      </div>
    </footer>
  );
}