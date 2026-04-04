import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Address } from "viem"
import type { AbstractViemJsonRpcAccount } from "@nktkas/hyperliquid/signing"

const execFileAsync = promisify(execFile)

const OWS_BINARY = "ows"

interface OwsSignResult {
  signature: string
  recovery_id: number
}

interface OwsSendResult {
  tx_hash: string
}

interface OwsWalletAccount {
  chain_id: string
  address: string
  derivation_path: string
}

interface OwsWalletInfo {
  id: string
  name: string
  accounts: OwsWalletAccount[]
  created_at: string
}

/**
 * Execute an OWS CLI command and return parsed JSON output
 */
async function owsExec(args: string[], timeout = 30_000, apiKey?: string): Promise<unknown> {
  try {
    const env = apiKey
      ? { ...process.env, OWS_PASSPHRASE: apiKey }
      : undefined
    const { stdout } = await execFileAsync(OWS_BINARY, args, {
      timeout,
      encoding: "utf-8",
      env,
    })
    return JSON.parse(stdout.trim())
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `"${OWS_BINARY}" not found. Install it with: npm install -g @open-wallet-standard/core\n` +
        "See: https://github.com/anthropics/open-wallet-standard",
      )
    }
    if (err && typeof err === "object" && "killed" in err && err.killed) {
      throw new Error(
        `OWS request timed out after ${Math.round(timeout / 1000)}s.`,
      )
    }
    // Try to extract a useful error message from stderr
    if (err && typeof err === "object" && "stderr" in err && typeof (err as { stderr: unknown }).stderr === "string") {
      const stderr = (err as { stderr: string }).stderr.trim()
      if (stderr) {
        throw new Error(`OWS error: ${stderr}`)
      }
    }
    throw err
  }
}

/**
 * Execute an OWS CLI command and return raw stdout (for non-JSON output)
 */
async function owsExecRaw(args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(OWS_BINARY, args, {
      timeout,
      encoding: "utf-8",
    })
    return stdout.trim()
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `"${OWS_BINARY}" not found. Install it with: npm install -g @open-wallet-standard/core`,
      )
    }
    if (err && typeof err === "object" && "stderr" in err && typeof (err as { stderr: unknown }).stderr === "string") {
      const stderr = (err as { stderr: string }).stderr.trim()
      if (stderr) {
        throw new Error(`OWS error: ${stderr}`)
      }
    }
    throw err
  }
}

/**
 * Check if the OWS binary is available on PATH
 */
export async function isOwsAvailable(): Promise<boolean> {
  try {
    await execFileAsync(OWS_BINARY, ["--version"], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * List all OWS wallets by parsing the `ows wallet list` text output.
 * Returns wallet names and their EVM addresses.
 */
export async function listOwsWallets(): Promise<{ name: string; evmAddress: Address }[]> {
  const raw = await owsExecRaw(["wallet", "list"])
  if (!raw || raw.includes("No wallets found")) {
    return []
  }

  const wallets: { name: string; evmAddress: Address }[] = []
  let currentName: string | null = null
  let currentAddress: Address | null = null

  for (const line of raw.split("\n")) {
    const nameMatch = line.match(/^Name:\s+(.+)$/)
    if (nameMatch) {
      // Save previous wallet if we have one
      if (currentName && currentAddress) {
        wallets.push({ name: currentName, evmAddress: currentAddress })
      }
      currentName = nameMatch[1].trim()
      currentAddress = null
    }
    // Match EVM address line: eip155:1 (ethereum) → 0x...
    const evmMatch = line.match(/eip155:\d+\s+\(ethereum\)\s+→\s+(0x[a-fA-F0-9]{40})/)
    if (evmMatch && currentName) {
      currentAddress = evmMatch[1] as Address
    }
  }
  // Don't forget the last wallet
  if (currentName && currentAddress) {
    wallets.push({ name: currentName, evmAddress: currentAddress })
  }

  return wallets
}

/**
 * Get the EVM address for a specific OWS wallet
 */
export async function getOwsWalletAddress(walletName: string): Promise<Address> {
  const wallets = await listOwsWallets()
  const wallet = wallets.find((w) => w.name === walletName)
  if (!wallet) {
    throw new Error(`OWS wallet "${walletName}" not found. Run 'ows wallet list' to see available wallets.`)
  }
  return wallet.evmAddress
}

/**
 * Sign EIP-712 typed data using the OWS CLI.
 * Returns a 65-byte signature (r + s + v) as a hex string with 0x prefix.
 */
async function signTypedDataViaOws(
  walletName: string,
  typedData: {
    domain: Record<string, unknown>
    types: Record<string, { name: string; type: string }[]>
    primaryType: string
    message: Record<string, unknown>
  },
): Promise<`0x${string}`> {
  const payload = JSON.stringify(typedData)

  // Note: EIP-712 typed data signing does not support API keys in OWS,
  // so we always use passphrase mode here. Policy enforcement happens
  // on transaction signing (fund/deposit operations) via owsSendTransaction.
  const result = await owsExec(
    ["sign", "message", "--chain", "ethereum", "--wallet", walletName, "--message", "eip712", "--typed-data", payload, "--json"],
    60_000,
  ) as OwsSignResult

  if (!result.signature) {
    throw new Error("OWS sign returned no signature")
  }

  // OWS returns signature as hex without 0x prefix, and recovery_id as the v value (27/28)
  // The SDK expects a 65-byte signature: r (32) + s (32) + v (1) as 0x-prefixed hex
  const sig = result.signature.replace(/^0x/, "")

  // Check if the signature already includes v (65 bytes = 130 hex chars)
  if (sig.length === 130) {
    return `0x${sig}` as `0x${string}`
  }

  // Otherwise append v byte (recovery_id is 27 or 28)
  const v = result.recovery_id.toString(16).padStart(2, "0")
  return `0x${sig}${v}` as `0x${string}`
}

/**
 * Send a raw transaction via OWS CLI (sign + broadcast).
 * Used for on-chain operations like the fund command.
 */
export async function owsSendTransaction(
  walletName: string,
  tx: { to: string; data: string; value: string; gas: string; chainId: string },
  rpcUrl: string,
  apiKey?: string,
): Promise<string> {
  // Convert the transaction to an unsigned RLP-encoded hex.
  // For EVM, OWS sign send-tx expects raw hex transaction bytes.
  // We'll use sign tx + manual broadcast since send-tx needs RLP encoding.
  // Instead, we'll sign the typed transaction data and broadcast ourselves.

  // Build the raw transaction hex for OWS
  // For simple ERC-20 calls, we encode as a type-2 (EIP-1559) transaction
  const chainIdNum = parseInt(tx.chainId.replace("eip155:", ""), 10)

  // Get current nonce and gas price from the RPC
  const walletAddress = await getOwsWalletAddress(walletName)
  const nonce = await rpcCall(rpcUrl, "eth_getTransactionCount", [walletAddress, "latest"]) as string
  const feeData = await rpcCall(rpcUrl, "eth_gasPrice", []) as string

  // Get maxPriorityFeePerGas for EIP-1559
  const maxPriorityFee = await rpcCall(rpcUrl, "eth_maxPriorityFeePerGas", []) as string

  // Add 20% buffer to maxFeePerGas to account for base fee fluctuations
  const baseFee = BigInt(feeData)
  const maxFeePerGas = baseFee + (baseFee * 20n / 100n)

  // Encode as EIP-1559 (type 2) transaction:
  // 0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])
  const txFields = rlpEncodeEip1559Tx({
    chainId: chainIdNum,
    nonce: parseInt(nonce, 16),
    maxPriorityFeePerGas: BigInt(maxPriorityFee),
    maxFeePerGas,
    gasLimit: BigInt(tx.gas.startsWith("0x") ? parseInt(tx.gas, 16) : parseInt(tx.gas)),
    to: tx.to,
    value: BigInt(tx.value.startsWith("0x") ? parseInt(tx.value, 16) : 0),
    data: tx.data,
  })

  const result = await owsExec(
    ["sign", "send-tx", "--chain", `eip155:${chainIdNum}`, "--wallet", walletName, "--tx", txFields, "--rpc-url", rpcUrl, "--json"],
    120_000,
    apiKey,
  ) as OwsSendResult

  if (!result.tx_hash) {
    throw new Error("OWS send-tx returned no transaction hash")
  }

  return result.tx_hash
}

/**
 * RLP-encode an EIP-1559 (type 2) transaction.
 * Returns hex string: "02" + RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])
 */
function rlpEncodeEip1559Tx(tx: {
  chainId: number
  nonce: number
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gasLimit: bigint
  to: string
  value: bigint
  data: string
}): string {
  const fields = [
    encodeRlpInteger(tx.chainId),
    encodeRlpInteger(tx.nonce),
    encodeRlpBigint(tx.maxPriorityFeePerGas),
    encodeRlpBigint(tx.maxFeePerGas),
    encodeRlpBigint(tx.gasLimit),
    encodeRlpBytes(tx.to),
    encodeRlpBigint(tx.value),
    encodeRlpBytes(tx.data),
    rlpEncodeEmptyList(), // accessList = []
  ]

  // Type 2 envelope: 0x02 prefix + RLP-encoded fields
  return "02" + rlpEncodeList(fields)
}

function encodeRlpInteger(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0x80]) // empty string
  if (n < 128) return new Uint8Array([n])
  const hex = n.toString(16)
  const padded = hex.length % 2 ? "0" + hex : hex
  const bytes = hexToBytes(padded)
  return rlpEncodeBytes(bytes)
}

function encodeRlpBigint(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0x80])
  const hex = n.toString(16)
  const padded = hex.length % 2 ? "0" + hex : hex
  const bytes = hexToBytes(padded)
  return rlpEncodeBytes(bytes)
}

function encodeRlpBytes(hexStr: string): Uint8Array {
  const clean = hexStr.replace(/^0x/, "")
  if (clean.length === 0) return new Uint8Array([0x80])
  const bytes = hexToBytes(clean)
  return rlpEncodeBytes(bytes)
}

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes
  }
  if (bytes.length <= 55) {
    const out = new Uint8Array(1 + bytes.length)
    out[0] = 0x80 + bytes.length
    out.set(bytes, 1)
    return out
  }
  const lenBytes = intToBytes(bytes.length)
  const out = new Uint8Array(1 + lenBytes.length + bytes.length)
  out[0] = 0xb7 + lenBytes.length
  out.set(lenBytes, 1)
  out.set(bytes, 1 + lenBytes.length)
  return out
}

function rlpEncodeEmptyList(): Uint8Array {
  // RLP encoding of an empty list is 0xc0
  return new Uint8Array([0xc0])
}

function rlpEncodeList(items: Uint8Array[]): string {
  let totalLen = 0
  for (const item of items) totalLen += item.length

  let result: Uint8Array
  if (totalLen <= 55) {
    result = new Uint8Array(1 + totalLen)
    result[0] = 0xc0 + totalLen
    let offset = 1
    for (const item of items) {
      result.set(item, offset)
      offset += item.length
    }
  } else {
    const lenBytes = intToBytes(totalLen)
    result = new Uint8Array(1 + lenBytes.length + totalLen)
    result[0] = 0xf7 + lenBytes.length
    result.set(lenBytes, 1)
    let offset = 1 + lenBytes.length
    for (const item of items) {
      result.set(item, offset)
      offset += item.length
    }
  }

  return Array.from(result).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

function intToBytes(n: number): Uint8Array {
  const hex = n.toString(16)
  const padded = hex.length % 2 ? "0" + hex : hex
  return hexToBytes(padded)
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

/**
 * Create an OWS wallet adapter that satisfies AbstractViemJsonRpcAccount.
 *
 * The adapter proxies signTypedData calls to the OWS CLI.
 * The signTypedData function must have .length === 1 to pass the SDK's
 * valibot schema check for viem JSON-RPC accounts.
 */
export function createOwsWallet(
  walletName: string,
  address: Address,
  apiKey?: string,
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
      return signTypedDataViaOws(walletName, {
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      })
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
