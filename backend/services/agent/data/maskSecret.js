export const maskSecret = (secret) => secret ? `••••${String(secret).slice(-4)}` : null;
