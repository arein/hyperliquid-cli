import { Command } from "commander"
import { getContext, getOutputOptions } from "../cli/program.js"
import { output, outputError, outputSuccess } from "../cli/output.js"
import { validateAddress } from "../lib/validation.js"

export function registerWithdrawCommand(program: Command): void {
  program
    .command("withdraw <amount>")
    .description("Withdraw USDC from Hyperliquid to your wallet on Arbitrum")
    .option("-d, --destination <address>", "Destination address (defaults to your wallet address)")
    .action(async function (this: Command, amountStr: string) {
      const ctx = getContext(this)
      const outputOpts = getOutputOptions(this)

      try {
        const amount = parseFloat(amountStr)
        if (isNaN(amount) || amount <= 0) {
          throw new Error("Amount must be a positive number.")
        }

        const rawDestination = this.opts().destination || ctx.config.walletAddress
        if (!rawDestination) {
          throw new Error(
            "No destination address. Specify one with --destination or set up an account first.",
          )
        }
        const destination = validateAddress(rawDestination)

        const client = ctx.getWalletClient()

        console.log(`\nWithdrawing ${amount} USDC to ${destination}...\n`)

        const result = await client.withdraw3({
          destination,
          amount: amount.toString(),
        })

        if (outputOpts.json) {
          output({
            status: "withdrawn",
            amount,
            destination,
            response: result,
          }, outputOpts)
        } else {
          outputSuccess(`Withdrew ${amount} USDC from Hyperliquid!`)
          console.log(`  Destination: ${destination}`)
          console.log("  Funds will arrive on Arbitrum within ~1 minute.")
          console.log("")
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}
