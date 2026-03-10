import type { Command } from "commander"
import { registerAccountCommands } from "./account/index.js"
import { registerMarketsCommands } from "./markets/index.js"
import { registerAssetCommands } from "./asset/index.js"
import { registerOrderCommands } from "./order/index.js"
import { registerServerCommands } from "./server.js"
import { registerUpgradeCommand } from "./upgrade.js"
import { registerFundCommand } from "./fund.js"
import { registerWithdrawCommand } from "./withdraw.js"

export function registerCommands(program: Command): void {
  registerAccountCommands(program)
  registerMarketsCommands(program)
  registerAssetCommands(program)
  registerOrderCommands(program)
  registerFundCommand(program)
  registerWithdrawCommand(program)
  registerServerCommands(program)
  registerUpgradeCommand(program)
}
