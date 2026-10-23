// Shared by runtime redaction and the repository's public-content check.
// Each alternative starts with a fixed prefix, then consumes one character
// class. Do not add nested or per-character alternation loops here.
export const PROVIDER_TOKEN_SOURCE = String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{30,}|sk_live_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35})\b`;
export const CLOUD_ACCESS_KEY_SOURCE = String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`;
export const PRIVATE_KEY_LABEL_SOURCE =
	'(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY';
