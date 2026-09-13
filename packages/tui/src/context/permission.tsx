import { useConfig } from "../config"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

export type PermissionMode = "prompt" | "autoaccept"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const config = useConfig()
    return {
      get mode(): PermissionMode {
        return args.auto ? "autoaccept" : config.data.session.permissions
      },
    }
  },
})
