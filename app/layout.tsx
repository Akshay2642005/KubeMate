import { Geist, Geist_Mono } from "next/font/google"
import Script from "next/script"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export const metadata = {
  title: "KubeMate",
  description: "The AI command center for Kubernetes teams.",
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
}

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

// Restores the persisted theme before first paint so a dark-mode user never
// sees a flash of the light theme (and vice versa) on refresh. Kept in
// public/theme-init.js (loaded as a classic beforeInteractive script) rather
// than inline so React never renders the <script> element itself.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable
      )}
    >
      <body>
        {/* Restores the persisted theme before first paint; see comment above. */}
        <Script src="/theme-init.js" strategy="beforeInteractive" />
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
