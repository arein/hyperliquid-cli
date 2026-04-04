#!/usr/bin/env bash
# OWS Executable Policy: Hyperliquid Daily Spending Limit
#
# Enforces a configurable daily spending limit for on-chain transactions.
# For message signing (no transaction context), allows by default.
# Receives policy context as JSON on stdin, outputs PolicyResult JSON on stdout.

CONTEXT=$(cat)

# Helper: extract a JSON string value (returns empty string if not found)
json_str() {
  echo "$CONTEXT" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/" 2>/dev/null || echo ""
}

# Helper: extract a JSON number value
json_num() {
  echo "$CONTEXT" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9.]*" | head -1 | sed "s/.*:[[:space:]]*//" 2>/dev/null || echo ""
}

# Check if this is a transaction signing (has transaction.raw_hex or transaction.data)
HAS_TX=$(echo "$CONTEXT" | grep -o '"raw_hex"' | head -1)

# If no transaction context, this is message signing — allow it
if [ -z "$HAS_TX" ]; then
  echo '{ "allow": true, "policy_id": "hl-spending-limit" }'
  exit 0
fi

DAILY_TOTAL=$(json_str "daily_total")
TX_DATA=$(json_str "data")
DAILY_LIMIT_USD=$(json_num "daily_limit_usd")

DAILY_LIMIT_USD=${DAILY_LIMIT_USD:-1}
DAILY_TOTAL=${DAILY_TOTAL:-0}
TX_VALUE=0

# Convert limit to USDC smallest unit (6 decimals)
DAILY_LIMIT_WEI=$(echo "$DAILY_LIMIT_USD * 1000000" | bc | cut -d. -f1)

# Parse ERC-20 transfer/approve amount from calldata
if [ -n "$TX_DATA" ]; then
  case "$TX_DATA" in
    0xa9059cbb*|0x095ea7b3*)
      AMOUNT_HEX=${TX_DATA: -64}
      AMOUNT_HEX_CLEAN=$(echo "$AMOUNT_HEX" | sed 's/^0*//')
      if [ -n "$AMOUNT_HEX_CLEAN" ]; then
        TX_VALUE=$(printf "%d" "0x$AMOUNT_HEX_CLEAN" 2>/dev/null || echo "0")
      fi
      ;;
  esac
fi

PROJECTED=$(( DAILY_TOTAL + TX_VALUE ))

if [ "$PROJECTED" -gt "$DAILY_LIMIT_WEI" ]; then
  DAILY_TOTAL_USD=$(echo "scale=2; $DAILY_TOTAL / 1000000" | bc)
  TX_VALUE_USD=$(echo "scale=2; $TX_VALUE / 1000000" | bc)
  cat <<EOF
{
  "allow": false,
  "reason": "Daily spending limit exceeded. Limit: \$${DAILY_LIMIT_USD}/day. Already spent today: \$${DAILY_TOTAL_USD}. This transaction: \$${TX_VALUE_USD}.",
  "policy_id": "hl-spending-limit"
}
EOF
else
  cat <<EOF
{
  "allow": true,
  "policy_id": "hl-spending-limit"
}
EOF
fi
