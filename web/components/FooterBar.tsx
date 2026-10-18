import { WeatherStrip } from "@/components/WeatherStrip";

/* One composition for both footers: the marketing shell renders this from the
   server Footer, the portal scroll container from the client ShellFooter. Keeping
   it in one place is what makes the bar identical on every page of the system. */
export function FooterBar({ brand, supportEmail, phone }:
  { brand: string; supportEmail: string; phone: string }) {
  return (
    <footer className="app-footer w-full py-12 text-[13px] tracking-[0.04em] text-white">
      <div className="footer-line">
        <span className="footer-words">{brand} | {supportEmail} | mob. {phone}</span>
        <WeatherStrip />
      </div>
    </footer>
  );
}
