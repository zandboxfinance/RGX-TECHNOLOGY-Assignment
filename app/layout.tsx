import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stock Overview Agents",
  description: "Parallel retrieval agents with a streamed LLM synthesis",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
