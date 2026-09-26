import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Diktat",
  description: "Deutsche Diktier-App mit Grok Transcribe von xAI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
