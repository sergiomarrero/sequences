import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rebel One Sequences",
  description: "Investor outreach sequences for Rebel One Venture Studios",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
