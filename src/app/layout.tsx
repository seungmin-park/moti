import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "moti · 나의 위시리스트",
  description: "갖고 싶은 것들을 나만의 공간에 담아두는 moti 위시리스트.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
