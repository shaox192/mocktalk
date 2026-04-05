"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useSettings } from "./SettingsContext";

export default function HeaderNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { clearSettings, sessionActive } = useSettings();

  const handleHomeClick = (e: React.MouseEvent) => {
    if (pathname === "/present" && sessionActive) {
      e.preventDefault();
      const confirmed = window.confirm(
        "Leave presentation? Your current session will be lost."
      );
      if (confirmed) {
        clearSettings();
        router.replace("/");
      }
    }
  };

  return (
    <header className={`${pathname === "/present" ? "bg-black" : "bg-[#d6cfc4]"} h-16 px-6 flex items-center gap-3 shrink-0 border-b border-[rgba(140,125,105,0.3)]`}>
      <Link href="/" onClick={handleHomeClick} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
        {/* Logo placeholder — replace /mocktalk-logo.png with your actual logo */}
        <Image
          src="/mocktalk-logo.png"
          alt="MockTalk logo"
          width={48}
          height={48}
          className="w-12 h-12"
        />
        <span className={`font-semibold text-2xl ${pathname === "/present" ? "text-[#EADABC]" : "text-[#2d2a26]"}`} style={{ fontFamily: 'var(--font-pixelify-sans)' }}>
          MockTalk
        </span>
      </Link>
    </header>
  );
}
