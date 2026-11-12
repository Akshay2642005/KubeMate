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
// sees a flash of the light theme (and vice versa) on refresh. Keep in sync
// with the class contract used by ThemeProvider (.light/.dark on <html>).
const themeInitScript = `(function () {
  try {
    var stored = window.localStorage.getItem("theme")
    var theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system"
    var dark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    var root = document.documentElement
    root.classList.remove("light", "dark")
    root.classList.add(dark ? "dark" : "light")
    root.style.colorScheme = dark ? "dark" : "light"
  } catch {}
})()`

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
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
