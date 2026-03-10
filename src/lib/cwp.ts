import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import type { Address } from "viem"
import type { AbstractViemJsonRpcAccount } from "@nktkas/hyperliquid/signing"

const execFileAsync = promisify(execFile)

/**
 * Execute a CWP binary command and return parsed JSON output
 */
export async function cwpExec(
  binary: string,
  args: string[],
  timeout = 30_000,
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout,
      encoding: "utf-8",
    })
    return JSON.parse(stdout.trim())
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `"${binary}" not found. Install it with: npm install -g @anthropic/walletconnect-cli\n` +
        "See: https://github.com/anthropic/walletconnect-cli",
      )
    }
    if (err && typeof err === "object" && "killed" in err && err.killed) {
      throw new Error(
        `WalletConnect request timed out after ${Math.round(timeout / 1000)}s. ` +
        "Check your phone and try again.",
      )
    }
    throw err
  }
}

/**
 * Check if the CWP binary is available on PATH
 */
export async function isCwpAvailable(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Connect to a wallet via CWP (shows QR code in terminal)
 * Spawns the connect command with inherited stdio so the QR code is visible,
 * then reads the connected address via whoami.
 */
export async function connectCwp(binary: string): Promise<Address> {
  // Spawn connect with inherited stdio so QR code renders in terminal
  // 5 minute timeout — user needs time to scan QR and approve on phone
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["connect"], { stdio: "inherit", timeout: 300_000 })
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`"${binary} connect" exited with code ${code}`))
      }
    })
    child.on("error", (err) => {
      if ("code" in err && err.code === "ENOENT") {
        reject(new Error(
          `"${binary}" not found. Install it with: npm install -g @anthropic/walletconnect-cli`,
        ))
      } else {
        reject(err)
      }
    })
  })

  // Read connected address — whoami returns { accounts: [{ chain, address }] }
  const result = await cwpExec(binary, ["whoami", "--json"]) as {
    accounts: { chain: string; address: string }[]
  }
  const address = result.accounts?.[0]?.address
  if (!address) {
    throw new Error("Failed to read wallet address after WalletConnect connection")
  }
  return address as Address
}

/**
 * Create a CWP wallet adapter that satisfies AbstractViemJsonRpcAccount.
 *
 * The adapter proxies signTypedData calls to the CWP binary subprocess.
 * The signTypedData function must have .length === 1 to pass the SDK's
 * valibot schema check for viem JSON-RPC accounts.
 */
export function createCwpWallet(
  binary: string,
  address: Address,
): AbstractViemJsonRpcAccount {
  return {
    // Single-param function — .length === 1 satisfies valibot check
    async signTypedData(params: {
      domain: {
        name: string
        version: string
        chainId: number
        verifyingContract: `0x${string}`
      }
      types: {
        [key: string]: { name: string; type: string }[]
      }
      primaryType: string
      message: Record<string, unknown>
    }): Promise<`0x${string}`> {
      const payload = JSON.stringify({
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      })

      // 120s timeout — user needs to approve on phone
      const result = await cwpExec(binary, ["sign-typed-data", payload], 120_000)
      const sig = result as { signature: string }
      if (!sig.signature) {
        throw new Error("CWP sign-typed-data returned no signature")
      }
      return sig.signature as `0x${string}`
    },

    async getAddresses(): Promise<`0x${string}`[]> {
      return [address as `0x${string}`]
    },

    async getChainId(): Promise<number> {
      // Arbitrum One — the SDK overrides chainId for L1 actions anyway
      return 42161
    },
  }
}
