import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  auto?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
