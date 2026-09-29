import fs from "node:fs";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.js";
import { logger } from "./logger.js";

const log = logger("mailer");

/*
  Outbound mail: sign-up verification, password resets, "you already have an account".
  Configured by SMTP_* env; without it nothing sends and sign-up says "not available yet".
  SMTP_HOST=stub writes each mail as a JSON file into DATA_DIR/mail-outbox — how the e2e
  suite's spawned servers hand verification links back to the test.
*/

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export function mailConfigured(): boolean {
  return !!config.smtp.host && (config.smtp.host === "stub" || !!config.smtp.from);
}

let transport: Transporter | null = null;

export async function sendMail(mail: Mail): Promise<void> {
  if (!mailConfigured()) throw new Error("no SMTP configured");
  if (config.smtp.host === "stub") {
    const dir = path.join(config.dataDir, "mail-outbox");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ ...mail, at: new Date().toISOString() }, null, 2));
    return;
  }
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transport.sendMail({ from: config.smtp.from, to: mail.to, subject: mail.subject, text: mail.text });
  log.info(`sent "${mail.subject}" to ${mail.to.replace(/(.).*(@.*)/, "$1***$2")}`);
}

const appUrl = () => config.publicUrl || "http://localhost:8080";

export function verifyMail(to: string, token: string): Mail {
  return {
    to,
    subject: "Confirm your email — AI Control Plane",
    text: `Welcome! Confirm your email address to open your workspace:

${appUrl()}/api/verify?token=${token}

The link works once and expires in 24 hours. If you didn't create this account, ignore this email and nothing will happen.`,
  };
}

export function resetMail(to: string, token: string): Mail {
  return {
    to,
    subject: "Reset your password — AI Control Plane",
    text: `Someone asked to reset the password for this account. If it was you, set a new one here:

${appUrl()}/?reset_token=${token}

The link works once and expires in 1 hour. If it wasn't you, ignore this email; your password is unchanged.`,
  };
}

export function alreadyRegisteredMail(to: string): Mail {
  return {
    to,
    subject: "You already have an account — AI Control Plane",
    text: `Someone (probably you) tried to sign up with this email address, but it already has an account.

Sign in here: ${appUrl()}
Forgot the password? Use "Forgot password?" on that page.

If this wasn't you, you can ignore this email.`,
  };
}
