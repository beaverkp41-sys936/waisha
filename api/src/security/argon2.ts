import { hash, verify } from "@node-rs/argon2";

const opts = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
export const hashPassword = (pw: string) => hash(pw, opts);
export const verifyPassword = (hashStr: string, pw: string) => verify(hashStr, pw);