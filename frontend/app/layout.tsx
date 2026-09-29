import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/app-shell";

// Geist (sans) — font zmienny, więc bez listy weight (dostajemy pełen zakres 300–700).
// latin-ext = polskie znaki (ą ć ę ł ń ó ś ź ż).
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

// JetBrains Mono — font monospaced design-systemu (--font-mono).
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Magazyn — i-coucou",
  description: "System zarządzania magazynem i importem",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      className={`${geistSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* #app: kontekst stackingu nad teksturą tła (body::before) — odpowiednik #root z mocka */}
        {/* Powłoka apki siedzi tutaj, a nie w page.tsx — layout nie montuje się
            od nowa przy zmianie adresu, więc stan (filtry listy, historia wejść)
            przeżywa nawigację. `children` to pusta strona catch-all. */}
        <div id="app"><AppShell />{children}</div>
      </body>
    </html>
  );
}
