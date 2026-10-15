import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Footer } from "@/components/Footer";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", display: "swap" });
export const metadata: Metadata = { title: "WAISHA", description: "Transport and logistics platform" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="min-h-screen flex flex-col font-sans">
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
