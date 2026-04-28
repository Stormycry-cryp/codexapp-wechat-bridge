const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Authorization:\s*Bearer\s+)([^\s]+)/gi, "$1[REDACTED]"],
  [/(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g, "$1[REDACTED]"],
  [/(context_token[=:]\s*)([^\s,}]+)/gi, "$1[REDACTED]"],
  [/(bot_token[=:]\s*)([^\s,}]+)/gi, "$1[REDACTED]"],
  [/(token[=:]\s*)([A-Za-z0-9._~+/=-]{16,})/gi, "$1[REDACTED]"]
];

export function redactSecrets(input: unknown): string {
  let text = typeof input === "string" ? input : JSON.stringify(input);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

