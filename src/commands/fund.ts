import { Command } from "commander"
import { getContext, getOutputOptions } from "../cli/program.js"
import { output, outputError, outputSuccess } from "../cli/output.js"
import { cwpExec } from "../lib/cwp.js"

// Arbitrum USDC (native)
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
const ARB_USDC_TESTNET = "0x1baAbB04529D43a73232B713C0FE471f7c7334d5"

// Hyperliquid Bridge2 contract on Arbitrum
const BRIDGE_MAINNET = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7"
const BRIDGE_TESTNET = "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89"

const ARB_CHAIN = "eip155:42161"
const ARB_CHAIN_TESTNET = "eip155:421614"
const ARB_RPC = "https://arb1.arbitrum.io/rpc"
const ARB_RPC_TESTNET = "https://sepolia-rollup.arbitrum.io/rpc"

interface TxReceipt { status: string; gasUsed: string; transactionHash: string }

/** Pad an address to 32-byte ABI-encoded form */
function padAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, "0")
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!res.ok) {
    throw new Error(`RPC request failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message} (code ${json.error.code})`)
  }
  return json.result
}

async function getUsdcBalance(rpc: string, usdcAddress: string, walletAddress: string): Promise<number> {
  // balanceOf(address) = 0x70a08231
  const data = "0x70a08231" + padAddress(walletAddress)
  const result = await rpcCall(rpc, "eth_call", [{ to: usdcAddress, data }, "latest"]) as string
  return parseInt(result, 16) / 1e6
}

async function pollReceipt(rpc: string, txHash: string, timeoutMs = 60_000): Promise<TxReceipt | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const receipt = await rpcCall(rpc, "eth_getTransactionReceipt", [txHash]) as TxReceipt | null
      if (receipt) return receipt
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return null
}

/**
 * Send a transaction via CWP binary, poll for receipt, and verify success.
 * Returns the confirmed transaction hash.
 */
async function sendAndConfirm(
  binary: string,
  rpc: string,
  tx: { to: string; data: string; value: string; gas: string; chainId: string },
  label: string,
): Promise<string> {
  const result = await cwpExec(binary, ["send-transaction", JSON.stringify(tx)], 120_000) as
    { transactionHash?: string }

  const txHash = result?.transactionHash
  if (!txHash) {
    throw new Error(`${label} failed — no transaction hash returned.`)
  }
  console.log(`  Tx: ${txHash}`)
  console.log("  Waiting for confirmation...")

  const receipt = await pollReceipt(rpc, txHash)
  if (!receipt) {
    throw new Error(`${label} timed out waiting for receipt.`)
  }
  if (receipt.status !== "0x1") {
    throw new Error(`${label} reverted on-chain.\n  Tx: ${txHash}`)
  }
  console.log("  Confirmed!")
  return txHash
}

export function registerFundCommand(program: Command): void {
  program
    .command("fund <amount>")
    .description("Deposit USDC into Hyperliquid (requires WalletConnect account)")
    .action(async function (this: Command, amountStr: string) {
      const ctx = getContext(this)
      const outputOpts = getOutputOptions(this)

      try {
        if (ctx.config.account?.type !== "walletconnect") {
          throw new Error(
            "The 'fund' command requires a WalletConnect account.\n" +
            "Run 'hl account add' and select 'Connect via WalletConnect'.",
          )
        }

        if (!ctx.config.cwpProvider) {
          throw new Error("No WalletConnect provider configured for this account.")
        }

        const amount = parseFloat(amountStr)
        if (isNaN(amount) || amount < 5) {
          throw new Error("Minimum deposit is 5 USDC. Amounts below 5 USDC will be lost.")
        }

        const isTestnet = ctx.config.testnet
        const usdcAddress = isTestnet ? ARB_USDC_TESTNET : ARB_USDC
        const bridgeAddress = isTestnet ? BRIDGE_TESTNET : BRIDGE_MAINNET
        const rpc = isTestnet ? ARB_RPC_TESTNET : ARB_RPC
        const chainId = isTestnet ? ARB_CHAIN_TESTNET : ARB_CHAIN
        const binary = ctx.config.cwpProvider
        const walletAddress = ctx.config.walletAddress
        if (!walletAddress) {
          throw new Error("No wallet address configured.")
        }

        // Pre-flight: check USDC balance on Arbitrum
        console.log("\nChecking USDC balance on Arbitrum...")
        const balance = await getUsdcBalance(rpc, usdcAddress, walletAddress)
        console.log(`  Balance: ${balance.toFixed(2)} USDC`)

        if (balance < amount) {
          throw new Error(
            balance < 5
              ? `Insufficient USDC on Arbitrum (${balance.toFixed(2)} USDC).\n` +
                "You need at least 5 USDC on Arbitrum to deposit.\n" +
                "Use 'walletconnect swidge' to bridge USDC to Arbitrum first."
              : `Insufficient USDC on Arbitrum: ${balance.toFixed(2)} USDC available, ${amount} USDC requested.\n` +
                "Use 'walletconnect swidge' to bridge more USDC to Arbitrum.",
          )
        }

        // USDC has 6 decimals
        const amountWei = Math.round(amount * 1e6)
        const amountHex = amountWei.toString(16).padStart(64, "0")
        const bridgePadded = padAddress(bridgeAddress)

        console.log(`\nDepositing ${amount} USDC into Hyperliquid...\n`)

        const baseTx = { to: usdcAddress, value: "0x0", gas: "0x186a0", chainId }

        // Step 1: Approve USDC to bridge contract
        // approve(address spender, uint256 amount) = 0x095ea7b3
        console.log("Step 1/2: Approving USDC transfer...")
        const approveHash = await sendAndConfirm(binary, rpc, {
          ...baseTx,
          data: "0x095ea7b3" + bridgePadded + amountHex,
        }, "Approval transaction")

        // Step 2: Transfer USDC to bridge contract
        // transfer(address to, uint256 amount) = 0xa9059cbb
        console.log("\nStep 2/2: Sending USDC to Hyperliquid bridge...")
        const txHash = await sendAndConfirm(binary, rpc, {
          ...baseTx,
          data: "0xa9059cbb" + bridgePadded + amountHex,
        }, "Transfer transaction")

        if (outputOpts.json) {
          output({
            status: "deposited",
            amount,
            approveTxHash: approveHash,
            transferTxHash: txHash,
            bridge: bridgeAddress,
          }, outputOpts)
        } else {
          console.log("")
          outputSuccess(`Deposited ${amount} USDC to Hyperliquid!`)
          console.log(`  Tx: ${txHash}`)
          console.log("  Funds will appear in your account within ~1 minute.")
          console.log("")
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}
