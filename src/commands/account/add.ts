import { Command } from "commander"
import { exec } from "child_process"
import { getContext, getOutputOptions } from "../../cli/program.js"
import { output, outputError, outputSuccess } from "../../cli/output.js"
import { validateAddress } from "../../lib/validation.js"
import { prompt, select, confirm, pressEnterOrEsc } from "../../lib/prompts.js"
import { createAccount, getAccountCount, isAliasTaken } from "../../lib/db/index.js"
import { validateApiKey } from "../../lib/api-wallet.js"
import { isCwpAvailable, connectCwp } from "../../lib/cwp.js"
import { isOwsAvailable, listOwsWallets } from "../../lib/ows.js"
import { installSpendingPolicy, isSpendingPolicyInstalled } from "../../lib/ows-policy.js"
import type { Hex } from "viem"

const REFERRAL_LINK = "https://app.hyperliquid.xyz/join/CHRISLING"
const CWP_BINARY = "walletconnect"

type SetupMethod = "existing" | "new" | "readonly" | "walletconnect" | "ows"

export function registerAddCommand(account: Command): void {
  account
    .command("add")
    .description("Add a new account (interactive wizard)")
    .action(async function (this: Command) {
      const ctx = getContext(this)
      const outputOpts = getOutputOptions(this)
      const isTestnet = ctx.config.testnet

      try {
        console.log("\n=== Add New Account ===\n")

        // Step 1: Choose setup method
        const setupMethod = await select<SetupMethod>("How would you like to add your account?", [
          {
            value: "existing",
            label: "Use existing wallet",
            description: "Import an API key from https://app.Hyperliquid.xyz/API",
          },
          {
            value: "new",
            label: "Create new wallet",
            description: "Generate a new wallet with encrypted keystore (Coming Soon)",
          },
          {
            value: "ows",
            label: "Connect via OWS (Open Wallet Standard)",
            description: "Use a local OWS wallet — encrypted, policy-gated signing",
          },
          {
            value: "walletconnect",
            label: "Connect via WalletConnect",
            description: "Scan QR code with mobile wallet — no private key needed",
          },
          {
            value: "readonly",
            label: "Add read-only account",
            description: "Watch a wallet without trading capabilities",
          },
        ])

        if (setupMethod === "new") {
          console.log("\nCreating new wallets with encrypted keystores is coming soon!")
          console.log("For now, please use an existing wallet or add a read-only account.\n")
          return
        }

        if (setupMethod === "existing") {
          await handleExistingWallet(isTestnet, outputOpts)
        } else if (setupMethod === "ows") {
          await handleOws(outputOpts)
        } else if (setupMethod === "walletconnect") {
          await handleWalletConnect(outputOpts)
        } else {
          await handleReadOnly(outputOpts)
        }
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}

async function handleExistingWallet(
  isTestnet: boolean,
  outputOpts: { json: boolean },
): Promise<void> {
  // Step 1: Get API private key
  const apiUrl = isTestnet
    ? "https://app.hyperliquid-testnet.xyz/API"
    : "https://app.hyperliquid.xyz/API"
  console.log(`\nVisit ${apiUrl} and click "Generate" to create one.\n`)
  const apiKeyInput = await prompt("Enter your API wallet private key: ")

  // Normalize the key (add 0x prefix if missing)
  let apiPrivateKey: Hex
  if (apiKeyInput.startsWith("0x")) {
    apiPrivateKey = apiKeyInput as Hex
  } else {
    apiPrivateKey = `0x${apiKeyInput}` as Hex
  }

  // Validate key format
  if (!/^0x[a-fA-F0-9]{64}$/.test(apiPrivateKey)) {
    throw new Error("Invalid private key format. Must be a 64-character hex string.")
  }

  // Step 2: Validate the API key
  console.log("\nValidating API key...")
  const result = await validateApiKey(apiPrivateKey, isTestnet)

  if (!result.valid) {
    throw new Error(result.error)
  }

  const apiWalletPublicKey = result.apiWalletAddress
  const userAddress = result.masterAddress

  console.log(`Valid API wallet for ${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`)

  // Step 3: Offer referral link for fee discount
  console.log(
    `\n\x1b[33m🎁 Get \x1b[1m\x1b[32m4% off\x1b[0m\x1b[33m trading fees with our referral link:\x1b[0m`,
  )
  console.log(`   \x1b[36m\x1b[4m${REFERRAL_LINK}\x1b[0m\n`)
  const openReferral = await pressEnterOrEsc("Press Enter to open in browser, or Esc to skip")
  if (openReferral) {
    openUrl(REFERRAL_LINK)
  }

  // Step 4: Get alias
  const alias = await promptForAlias()

  // Step 5: Check if user wants to set as default
  let setAsDefault = false
  const existingCount = getAccountCount()

  if (existingCount > 0) {
    setAsDefault = await confirm("\nSet this as your default account?", true)
  }

  // Step 6: Save account
  const newAccount = createAccount({
    alias,
    userAddress,
    type: "api_wallet",
    source: "cli_import",
    apiWalletPrivateKey: apiPrivateKey,
    apiWalletPublicKey,
    setAsDefault,
  })

  if (outputOpts.json) {
    output(
      {
        ...newAccount,
        apiWalletPrivateKey: "[REDACTED]",
      },
      outputOpts,
    )
  } else {
    console.log("")
    outputSuccess(`Account "${alias}" added successfully!`)
    console.log("")
    console.log("Account details:")
    console.log(`  Alias: ${newAccount.alias}`)
    console.log(`  Address: ${newAccount.userAddress}`)
    console.log(`  Type: ${newAccount.type}`)
    console.log(`  API Wallet: ${newAccount.apiWalletPublicKey}`)
    console.log(`  Default: ${newAccount.isDefault ? "Yes" : "No"}`)
    console.log("")
  }
}

async function handleReadOnly(outputOpts: { json: boolean }): Promise<void> {
  // Step 1: Get wallet address
  console.log("")
  const userAddressInput = await prompt("Enter the wallet address to watch: ")
  const userAddress = validateAddress(userAddressInput)

  // Step 2: Get alias
  const alias = await promptForAlias()

  // Step 3: Check if user wants to set as default
  let setAsDefault = false
  const existingCount = getAccountCount()

  if (existingCount > 0) {
    setAsDefault = await confirm("\nSet this as your default account?", true)
  }

  // Step 4: Save account
  const newAccount = createAccount({
    alias,
    userAddress,
    type: "readonly",
    source: "cli_import",
    setAsDefault,
  })

  if (outputOpts.json) {
    output(newAccount, outputOpts)
  } else {
    console.log("")
    outputSuccess(`Account "${alias}" added successfully!`)
    console.log("")
    console.log("Account details:")
    console.log(`  Alias: ${newAccount.alias}`)
    console.log(`  Address: ${newAccount.userAddress}`)
    console.log(`  Type: ${newAccount.type}`)
    console.log(`  Default: ${newAccount.isDefault ? "Yes" : "No"}`)
    console.log("")
  }
}

async function handleWalletConnect(outputOpts: { json: boolean }): Promise<void> {
  // Step 1: Check if walletconnect binary is available
  const available = await isCwpAvailable(CWP_BINARY)
  if (!available) {
    throw new Error(
      `"${CWP_BINARY}" CLI not found on PATH.\n` +
      "Install it with: npm install -g @anthropic/walletconnect-cli",
    )
  }

  // Step 2: Connect via WalletConnect (QR code displayed in terminal)
  console.log("\nStarting WalletConnect session...\n")
  const userAddress = await connectCwp(CWP_BINARY)
  console.log(`\nConnected wallet: ${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`)

  // Step 3: Get alias
  const alias = await promptForAlias()

  // Step 4: Check if user wants to set as default
  let setAsDefault = false
  const existingCount = getAccountCount()

  if (existingCount > 0) {
    setAsDefault = await confirm("\nSet this as your default account?", true)
  }

  // Step 5: Save account
  const newAccount = createAccount({
    alias,
    userAddress,
    type: "walletconnect",
    source: "cli_import",
    cwpProvider: CWP_BINARY,
    setAsDefault,
  })

  if (outputOpts.json) {
    output(newAccount, outputOpts)
  } else {
    console.log("")
    outputSuccess(`Account "${alias}" added successfully!`)
    console.log("")
    console.log("Account details:")
    console.log(`  Alias: ${newAccount.alias}`)
    console.log(`  Address: ${newAccount.userAddress}`)
    console.log(`  Type: ${newAccount.type}`)
    console.log(`  Provider: ${newAccount.cwpProvider}`)
    console.log(`  Default: ${newAccount.isDefault ? "Yes" : "No"}`)
    console.log("")
    console.log("Trading orders will require approval on your mobile wallet.")
    console.log("")
  }
}

async function handleOws(outputOpts: { json: boolean }): Promise<void> {
  // Step 1: Check if OWS binary is available
  const available = await isOwsAvailable()
  if (!available) {
    throw new Error(
      `"ows" CLI not found on PATH.\n` +
      "Install it with: npm install -g @open-wallet-standard/core",
    )
  }

  // Step 2: List available OWS wallets
  console.log("\nFetching OWS wallets...\n")
  const wallets = await listOwsWallets()

  if (wallets.length === 0) {
    throw new Error(
      "No OWS wallets found. Create one first with:\n" +
      "  ows wallet create --name my-wallet",
    )
  }

  // Step 3: Let user pick a wallet
  const choices = wallets.map((w) => ({
    value: w.name,
    label: w.name,
    description: `${w.evmAddress.slice(0, 6)}...${w.evmAddress.slice(-4)}`,
  }))

  const selectedWallet = await select<string>("Select an OWS wallet:", choices)
  const wallet = wallets.find((w) => w.name === selectedWallet)!
  const userAddress = wallet.evmAddress

  console.log(`\nSelected wallet: ${selectedWallet} (${userAddress.slice(0, 6)}...${userAddress.slice(-4)})`)

  // Step 4: Ask for OWS API key (enables policy enforcement)
  let owsApiKey: string | undefined
  const useApiKey = await confirm(
    "Use an OWS API key? (enables spending policy enforcement)",
    true,
  )
  if (useApiKey) {
    const keyInput = await prompt("Enter your OWS API key (ows_key_...): ")
    if (keyInput && keyInput.startsWith("ows_key_")) {
      owsApiKey = keyInput
    } else if (keyInput) {
      console.log("  Invalid API key format (must start with ows_key_). Skipping — will use passphrase mode.")
    }
  }

  // Step 5: Get alias
  const alias = await promptForAlias()

  // Step 6: Check if user wants to set as default
  let setAsDefault = false
  const existingCount = getAccountCount()

  if (existingCount > 0) {
    setAsDefault = await confirm("\nSet this as your default account?", true)
  }

  // Step 7: Save account
  const newAccount = createAccount({
    alias,
    userAddress,
    type: "ows",
    source: "cli_import",
    owsWalletName: selectedWallet,
    owsApiKey,
    setAsDefault,
  })

  if (outputOpts.json) {
    output({
      ...newAccount,
      owsApiKey: owsApiKey ? "[REDACTED]" : null,
    }, outputOpts)
  } else {
    console.log("")
    outputSuccess(`Account "${alias}" added successfully!`)
    console.log("")
    console.log("Account details:")
    console.log(`  Alias: ${newAccount.alias}`)
    console.log(`  Address: ${newAccount.userAddress}`)
    console.log(`  Type: ${newAccount.type}`)
    console.log(`  OWS Wallet: ${newAccount.owsWalletName}`)
    console.log(`  API Key: ${owsApiKey ? "configured (policy-enforced)" : "none (passphrase mode)"}`)
    console.log(`  Default: ${newAccount.isDefault ? "Yes" : "No"}`)
    console.log("")
    if (owsApiKey) {
      console.log("Signing will use the API key — OWS policies are enforced.")
    } else {
      console.log("Signing will prompt for your wallet passphrase (no policy enforcement).")
    }
    console.log("")

    // Offer to install spending policy if using API key and policy not yet installed
    if (owsApiKey) {
      const policyInstalled = await isSpendingPolicyInstalled()
      if (!policyInstalled) {
        const installPolicy = await confirm(
          "Install a daily spending limit policy for on-chain transactions?",
          true,
        )
        if (installPolicy) {
          const limitStr = await prompt("Daily spending limit in USD (default: 20): ")
          const dailyLimit = limitStr ? parseFloat(limitStr) : 20
          if (isNaN(dailyLimit) || dailyLimit <= 0) {
            console.log("  Invalid amount, using $20 default.")
          }
          const limit = isNaN(dailyLimit) || dailyLimit <= 0 ? 20 : dailyLimit
          try {
            await installSpendingPolicy(limit)
            outputSuccess(`Spending limit policy installed (max $${limit}/day for on-chain transactions).`)
            console.log("")
          } catch (err) {
            console.log(`  Warning: Could not install policy: ${err instanceof Error ? err.message : String(err)}`)
            console.log("")
          }
        }
      } else {
        console.log("Spending limit policy is already installed.")
        console.log("")
      }
    }
  }
}

async function promptForAlias(): Promise<string> {
  while (true) {
    const alias = await prompt("Enter an alias for this account (e.g., 'main', 'trading'): ")
    if (!alias) {
      console.log("Alias cannot be empty.")
      continue
    }
    if (isAliasTaken(alias)) {
      console.log(`Alias "${alias}" is already taken. Please choose another.`)
      continue
    }
    return alias
  }
}

function openUrl(url: string): void {
  const platform = process.platform
  const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"
  exec(`${command} "${url}"`)
}
