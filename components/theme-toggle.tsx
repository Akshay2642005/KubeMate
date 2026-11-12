"use client"

import * as React from "react"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const options = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const

// A visible theme switch for the sidebar footer. The "d" hotkey still works
// for quick toggling between light and dark.
function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  // The server always renders the "system" icon, but the client's first
  // render may read a different persisted theme from localStorage. Render the
  // stable system icon until mounted so server and client HTML match.
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
  const CurrentIcon = !mounted
    ? MonitorIcon
    : (options.find((option) => option.value === theme)?.icon ??
      (resolvedTheme === "dark" ? MoonIcon : SunIcon))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 px-2 text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            aria-label="Change theme"
          />
        }
      >
        <CurrentIcon className="size-4 shrink-0" />
        <span className="truncate group-data-[collapsible=icon]:hidden">
          Theme
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value)}
        >
          {options.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ThemeToggle }
