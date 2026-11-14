#!/bin/sh
# Pre-commit gate: the full check must pass. Prints only the summary.
out=$(bun run check 2>&1); code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)|error|×" | head -8
exit $code
