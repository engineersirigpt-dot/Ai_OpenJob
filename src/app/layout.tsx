import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Meeting Assistant",
  description: "ผู้ช่วย AI เข้าร่วมประชุม — ฟัง อ่านเอกสาร เสนอความคิดเห็น และตอบคำถาม",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
