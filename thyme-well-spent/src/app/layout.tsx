import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { themeScript } from "@/components/ui/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Thyme Well Spent — meal planning that fits your life", template: "%s · Thyme" },
  description: "Personalised meal plans, recipes, grocery lists and nutrition tracking.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, title: "Thyme", statusBarStyle: "default" },
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#FBF8F3" }, { media: "(prefers-color-scheme: dark)", color: "#16120F" }], width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to content</a>
        {children}
        <Toaster position="top-center" toastOptions={{ className: "!rounded-2xl !font-sans" }} />
      </body>
    </html>
  );
}
