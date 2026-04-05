import type { Metadata } from "next";
import { Roboto_Mono, Pixelify_Sans } from "next/font/google";
import "./globals.css";
import { SettingsProvider } from "./SettingsContext";
import HeaderNav from "./HeaderNav";

const robotoMono = Roboto_Mono({
  variable: "--font-roboto-mono",
  subsets: ["latin"],
});

const pixelifySans = Pixelify_Sans({
  variable: "--font-pixelify-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MockTalk",
  description: "Your AI Academic Presentation Coach",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${robotoMono.variable} ${pixelifySans.variable} antialiased flex flex-col h-screen`}
      >
        <SettingsProvider>
          <HeaderNav />
          <main className="flex-1 overflow-hidden">{children}</main>
        </SettingsProvider>
      </body>
    </html>
  );
}
