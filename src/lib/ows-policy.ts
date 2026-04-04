import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { HL_DIR } from "./paths.js"

const execFileAsync = promisify(execFile)

const OWS_BINARY = "ows"

/**
 * Install the Hyperliquid spending limit policy into OWS.
 *
 * Creates the executable script in ~/.hl/policies/ and registers
 * the policy with OWS via `ows policy create`.
 *
 * @param dailyLimitUsd - Maximum daily spend in USD (default: 20)
 */
export async function installSpendingPolicy(dailyLimitUsd = 20): Promise<string> {
  // Create the policy directory
  const policyDir = join(HL_DIR, "policies")
  mkdirSync(policyDir, { recursive: true })

  // Write the executable policy script
  const scriptPath = join(policyDir, "hl-spending-limit.sh")
  writeFileSync(scriptPath, SPENDING_LIMIT_SCRIPT, { mode: 0o755 })

  // Write the policy JSON to a temp file with the correct executable path
  const policyJson = {
    id: "hl-spending-limit",
    name: "Hyperliquid Daily Spending Limit",
    version: 1,
    created_at: new Date().toISOString(),
    rules: [
      {
        type: "allowed_chains",
        chain_ids: ["eip155:1", "eip155:42161", "eip155:421614"],
      },
    ],
    executable: scriptPath,
    config: {
      daily_limit_usd: dailyLimitUsd,
    },
    action: "deny",
  }

  const tmpFile = join(tmpdir(), `hl-policy-${Date.now()}.json`)
  writeFileSync(tmpFile, JSON.stringify(policyJson, null, 2))

  try {
    await execFileAsync(OWS_BINARY, ["policy", "create", "--file", tmpFile], {
      timeout: 10_000,
      encoding: "utf-8",
    })
  } catch (err: unknown) {
    // Check if policy already exists
    if (err && typeof err === "object" && "stderr" in err) {
      const stderr = String((err as { stderr: unknown }).stderr)
      if (stderr.includes("already exists")) {
        return "hl-spending-limit"
      }
    }
    throw err
  }

  return "hl-spending-limit"
}

/**
 * Create an OWS API key for a wallet with the spending limit policy attached.
 *
 * @param walletName - OWS wallet name
 * @param policyId - Policy ID to attach
 * @returns The API key token (shown once)
 */
export async function createOwsApiKey(
  walletName: string,
  policyId: string,
): Promise<{ token: string; id: string }> {
  const { stdout } = await execFileAsync(
    OWS_BINARY,
    [
      "key", "create",
      "--name", `hl-${walletName}`,
      "--wallet", walletName,
      "--policy", policyId,
    ],
    { timeout: 30_000, encoding: "utf-8" },
  )

  // Parse the output for token and key ID
  const tokenMatch = stdout.match(/Token:\s+(ows_key_\S+)/)
  const idMatch = stdout.match(/ID:\s+(\S+)/)

  if (!tokenMatch) {
    throw new Error("Failed to parse API key token from OWS output")
  }

  return {
    token: tokenMatch[1],
    id: idMatch?.[1] || "unknown",
  }
}

/**
 * List existing OWS policies to check if spending limit is already installed.
 */
export async function isSpendingPolicyInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(OWS_BINARY, ["policy", "list"], {
      timeout: 5_000,
      encoding: "utf-8",
    })
    return stdout.includes("hl-spending-limit")
  } catch {
    return false
  }
}

// The actual spending limit script content (embedded so it can be installed without
// needing to find the package's policies/ directory at runtime)
const SPENDING_LIMIT_SCRIPT = `#!/usr/bin/env bash
# OWS Executable Policy: Hyperliquid Daily Spending Limit
CONTEXT=$(cat)

json_str() {
  echo "$CONTEXT" | grep -o "\\"$1\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -1 | sed "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/" 2>/dev/null || echo ""
}

json_num() {
  echo "$CONTEXT" | grep -o "\\"$1\\"[[:space:]]*:[[:space:]]*[0-9.]*" | head -1 | sed "s/.*:[[:space:]]*//" 2>/dev/null || echo ""
}

# Check if this is a transaction signing (has raw_hex)
RAW_HEX=$(json_str "raw_hex")

# If no transaction context, this is message signing — allow it
if [ -z "$RAW_HEX" ]; then
  echo '{ "allow": true, "policy_id": "hl-spending-limit" }'
  exit 0
fi

DAILY_TOTAL=$(json_str "daily_total")
DAILY_LIMIT_USD=$(json_num "daily_limit_usd")

DAILY_LIMIT_USD=\${DAILY_LIMIT_USD:-1}
DAILY_TOTAL=\${DAILY_TOTAL:-0}
TX_VALUE=0

DAILY_LIMIT_WEI=$(echo "$DAILY_LIMIT_USD * 1000000" | bc | cut -d. -f1)

# Use raw_hex as the transaction data (strip 0x prefix if present)
TX_DATA="\${RAW_HEX#0x}"

# Parse ERC-20 transfer/approve amount from calldata
# transfer: a9059cbb, approve: 095ea7b3
case "$TX_DATA" in
  a9059cbb*|095ea7b3*)
    AMOUNT_HEX=\${TX_DATA: -64}
    AMOUNT_HEX_CLEAN=$(echo "$AMOUNT_HEX" | sed 's/^0*//')
    if [ -n "$AMOUNT_HEX_CLEAN" ]; then
      TX_VALUE=$(printf "%d" "0x$AMOUNT_HEX_CLEAN" 2>/dev/null || echo "0")
    fi
    ;;
esac

PROJECTED=$(( DAILY_TOTAL + TX_VALUE ))

if [ "$PROJECTED" -gt "$DAILY_LIMIT_WEI" ]; then
  DAILY_TOTAL_USD=$(echo "scale=2; $DAILY_TOTAL / 1000000" | bc)
  TX_VALUE_USD=$(echo "scale=2; $TX_VALUE / 1000000" | bc)
  cat <<PEOF
{
  "allow": false,
  "reason": "Daily spending limit exceeded. Limit: \\$\${DAILY_LIMIT_USD}/day. Already spent today: \\$\${DAILY_TOTAL_USD}. This transaction: \\$\${TX_VALUE_USD}.",
  "policy_id": "hl-spending-limit"
}
PEOF
else
  cat <<PEOF
{
  "allow": true,
  "policy_id": "hl-spending-limit"
}
PEOF
fi
`
