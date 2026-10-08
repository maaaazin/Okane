import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Okane | Agentic Trading Research",
  description: "Human-approved, paper-trading research powered by collaborating AI agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
