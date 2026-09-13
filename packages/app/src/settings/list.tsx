import type { Component, JSX } from "solid-js"
import "@/settings/settings.css"

export const SettingsList: Component<{ children: JSX.Element; variant?: "catalog" }> = (props) => {
  return (
    <div data-component="settings-list" data-variant={props.variant}>
      {props.children}
    </div>
  )
}
