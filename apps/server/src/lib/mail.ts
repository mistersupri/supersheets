import nodemailer from 'nodemailer';
import { config } from '../config';

const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

/**
 * Sends an email. Without SMTP_URL the message is written to the server log,
 * which is how password-reset and invitation links are read in development.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!transport) {
    console.info(`[mail] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await transport.sendMail({ from: config.mailFrom, to, subject, text });
}
