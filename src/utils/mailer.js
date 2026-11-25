const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('./logger');

/*
 * Two ways to send, picked from the environment:
 *   - BREVO_API_KEY set -> Brevo's HTTPS API (port 443). Use this on hosts that block SMTP, e.g. Render's free plan.
 *   - SMTP_HOST set     -> SMTP (Gmail, SES, ...).
 * With neither, mails are printed to the console.
 */
const BREVO_API = 'https://api.brevo.com/v3';

let transporter = null;
if (!env.BREVO_API_KEY && env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // Requests wait for the send, so a stuck SMTP server must fail fast instead of hitting the host's time limit.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
}

/** "Papolona <hello@x.com>" -> { name: 'Papolona', email: 'hello@x.com' } */
function parseAddress(address) {
  const match = address.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return match ? { name: match[1] || undefined, email: match[2].trim() } : { email: address.trim() };
}

async function brevoRequest(path, options = {}) {
  const res = await fetch(`${BREVO_API}${path}`, {
    ...options,
    headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return res.json();
}

/** In tests, sent mails are collected here so specs can read codes. */
const outbox = [];

async function sendMail({ to, subject, text, html }) {
  if (env.NODE_ENV === 'test') {
    outbox.push({ to, subject, text });
    return;
  }
  if (env.BREVO_API_KEY) {
    await brevoRequest('/smtp/email', {
      method: 'POST',
      body: JSON.stringify({
        sender: parseAddress(env.MAIL_FROM),
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
      }),
    });
    return;
  }
  if (!transporter) {
    // Development without a mail provider: print the mail so codes can be used locally.
    logger.info(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
}

/** Checks the mail login at start-up so a wrong key or password shows in the log immediately. Never throws. */
async function verifyMailer() {
  if (env.BREVO_API_KEY) {
    try {
      const account = await brevoRequest('/account');
      logger.info(`Brevo ready (account ${account.email}, sending as ${parseAddress(env.MAIL_FROM).email})`);
    } catch (err) {
      logger.error(`Brevo API key check failed: ${err.message}`);
    }
    return;
  }
  if (!transporter) {
    logger.warn('No mail provider set (BREVO_API_KEY or SMTP_HOST): emails, including codes, are printed to the console, not sent.');
    return;
  }
  try {
    await transporter.verify();
    logger.info(`SMTP ready (${env.SMTP_HOST}:${env.SMTP_PORT} as ${env.SMTP_USER})`);
  } catch (err) {
    logger.error(`SMTP login failed for ${env.SMTP_HOST}: ${err.message}`);
  }
}

const templates = {
  resetCode: (name, code, minutes) => ({
    subject: 'Your Papolona password reset code',
    text:
      `Hello ${name},\n\n` +
      `Your password reset code is: ${code}\n\n` +
      `It expires in ${minutes} minutes. If you did not request this, you can ignore this email; ` +
      `your password will not change.\n\nPapolona`,
  }),
  passwordChanged: (name) => ({
    subject: 'Your Papolona password was changed',
    text:
      `Hello ${name},\n\nThe password for your Papolona account was just changed, ` +
      `and all other devices were signed out.\n\n` +
      `If this was not you, reset your password immediately from the app and contact support.\n\nPapolona`,
  }),
  changeCode: (name, code, minutes, action) => ({
    subject: 'Your Papolona confirmation code',
    text:
      `Hello ${name},\n\n` +
      `Your code to ${action} is: ${code}\n\n` +
      `It expires in ${minutes} minutes. If you did not ask for this, ignore this email and nothing will change. ` +
      `If it keeps happening, change your password.\n\nPapolona`,
  }),
  phoneChanged: (name, phone) => ({
    subject: 'Your Papolona phone number was changed',
    text:
      `Hello ${name},\n\n` +
      (phone ? `The phone number on your Papolona account is now ${phone}.` : 'The phone number was removed from your Papolona account.') +
      `\n\nIf this was not you, change your password and contact support.\n\nPapolona`,
  }),
  emailChanged: (name, newEmail) => ({
    subject: 'Your Papolona email was changed',
    text:
      `Hello ${name},\n\nThe email for your Papolona account was just changed to ${newEmail}. ` +
      `You will now sign in with that address.\n\n` +
      `If this was not you, contact support immediately.\n\nPapolona`,
  }),
  welcome: (name) => ({
    subject: 'Welcome to Papolona',
    text:
      `Hello ${name},\n\nYour Papolona account has been created. ` +
      `You are now in the learning and probation stage. Begin with Induction Level 1 in the app.\n\nPapolona`,
  }),
};

module.exports = { sendMail, verifyMailer, templates, outbox };
