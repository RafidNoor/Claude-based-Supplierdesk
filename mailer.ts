import nodemailer from 'nodemailer';
import { getConfig, saveConfig } from './db.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Intelligently determines whether 'secure' (direct TLS handshake upon connect)
 * should be enabled or disabled based on standard SMTP RFC port conventions.
 * - Port 465: Direct SSL/TLS (secure = true)
 * - Port 587 / 25 / 2525: STARTTLS upgrade after plaintext greeting (secure = false)
 * Connecting with secure: true on Port 587 triggers OpenSSL 'tls_validate_record_header:wrong version number'.
 */
export function determineSmtpSecure(port: number, explicitSecure?: boolean): boolean {
  if (port === 465) {
    return true;
  }
  if (port === 587 || port === 25 || port === 2525) {
    return false;
  }
  return explicitSecure !== undefined ? Boolean(explicitSecure) : false;
}

export async function getActiveSmtpConfig(): Promise<SmtpConfig | null> {
  const envHost = process.env.SMTP_HOST;
  const envUser = process.env.SMTP_USER;
  const envPass = process.env.SMTP_PASS;

  if (envHost && envUser && envPass) {
    const port = Number(process.env.SMTP_PORT) || 587;
    const explicitSecure = process.env.SMTP_SECURE === 'true';
    return {
      host: envHost.trim(),
      port,
      secure: determineSmtpSecure(port, explicitSecure),
      user: envUser.trim(),
      pass: envPass.trim(),
      from: process.env.SMTP_FROM || `Daraz SupplierDesk <${envUser.trim()}>`
    };
  }

  const appConfig = await getConfig();
  if (appConfig.smtp_host && appConfig.smtp_user && appConfig.smtp_pass) {
    const port = Number(appConfig.smtp_port) || 587;
    return {
      host: String(appConfig.smtp_host).trim(),
      port,
      secure: determineSmtpSecure(port, Boolean(appConfig.smtp_secure)),
      user: String(appConfig.smtp_user).trim(),
      pass: String(appConfig.smtp_pass).trim(),
      from: String(appConfig.smtp_from || '').trim() || `Daraz SupplierDesk <${appConfig.smtp_user}>`
    };
  }

  return null;
}

export async function isSmtpConfigured(): Promise<boolean> {
  const config = await getActiveSmtpConfig();
  return config !== null;
}

export function createTransporter(config: SmtpConfig, overrideSecure?: boolean) {
  const isSecure = overrideSecure !== undefined ? overrideSecure : config.secure;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: isSecure,
    auth: {
      user: config.user,
      pass: config.pass
    },
    tls: {
      // Allow servers with valid or self-signed certs without crashing
      rejectUnauthorized: false
    },
    connectionTimeout: 12000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function isTlsProtocolMismatchError(err: any): boolean {
  const msg = (err?.message || '') + (err?.stack || '') + (err?.code || '');
  return (
    msg.includes('wrong version number') ||
    msg.includes('tls_validate_record_header') ||
    msg.includes('SSL routines') ||
    msg.includes('ECONNRESET')
  );
}

function formatFriendlySmtpError(err: any, config: SmtpConfig): string {
  const rawMsg = err?.message || String(err);
  if (isTlsProtocolMismatchError(err)) {
    return `SSL/TLS protocol mismatch: Port ${config.port} expects ${config.secure ? 'STARTTLS (SSL must be unchecked)' : 'direct SSL (SSL must be checked)'}. Tip: Port 587 requires SSL OFF; Port 465 requires SSL ON.`;
  }
  if (rawMsg.includes('535') || rawMsg.includes('Username and Password not accepted') || rawMsg.includes('BadCredentials')) {
    return `Authentication failed (535): Invalid username or password. If using Gmail, you MUST generate a 16-character App Password at https://myaccount.google.com/apppasswords (normal Google passwords are rejected).`;
  }
  if (rawMsg.includes('ENOTFOUND') || rawMsg.includes('getaddrinfo')) {
    return `Host '${config.host}' could not be resolved. Check your SMTP server hostname.`;
  }
  if (rawMsg.includes('ETIMEDOUT') || rawMsg.includes('ECONNREFUSED')) {
    return `Connection to ${config.host}:${config.port} timed out or was refused. Check your port and firewall.`;
  }
  return rawMsg;
}

export async function sendOtpEmail(params: {
  to: string;
  name?: string;
  otp: string;
  purpose: 'reset_password' | 'forgot_email' | 'login' | string;
}): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const config = await getActiveSmtpConfig();
  if (!config) {
    return { sent: false, error: 'SMTP configuration is not set' };
  }

  const { to, name, otp, purpose } = params;
  const recipientName = name || 'Seller';

  let purposeTitle = 'Account Security Verification';
  let purposeDescription = 'Please use the verification code below to complete your request.';

  if (purpose === 'reset_password') {
    purposeTitle = 'Password Reset Request';
    purposeDescription = 'We received a request to reset your Daraz SupplierDesk account password.';
  } else if (purpose === 'forgot_email') {
    purposeTitle = 'Account Identity Verification';
    purposeDescription = 'Use this verification code to confirm ownership of your Daraz SupplierDesk account.';
  } else if (purpose === 'login') {
    purposeTitle = 'One-Time Login Code';
    purposeDescription = 'Use this one-time password to sign in securely to your Daraz SupplierDesk dashboard.';
  }

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${purposeTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e2e8f0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0f172a; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 520px; background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);" cellspacing="0" cellpadding="0">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #f85606 0%, #ff7700 100%); padding: 24px 32px; text-align: left;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">⚡ Daraz SupplierDesk</span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; background-color: rgba(255,255,255,0.25); color: #ffffff; padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Security</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <h2 style="margin: 0 0 12px 0; font-size: 18px; font-weight: 700; color: #ffffff;">
                Hello, ${recipientName}
              </h2>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #94a3b8;">
                ${purposeDescription}
              </p>

              <!-- OTP Box -->
              <div style="background-color: #0f172a; border: 2px dashed #f85606; border-radius: 10px; padding: 20px; text-align: center; margin-bottom: 24px;">
                <span style="display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; color: #fdba74; letter-spacing: 1px; margin-bottom: 8px;">
                  Your 6-Digit Verification Code
                </span>
                <span style="display: inline-block; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #ffffff; font-family: 'Courier New', Courier, monospace; background: #1e293b; padding: 6px 18px; border-radius: 6px; border: 1px solid #334155;">
                  ${otp}
                </span>
                <span style="display: block; font-size: 12px; color: #64748b; margin-top: 10px;">
                  ⏱ This code is valid for <strong>10 minutes</strong>.
                </span>
              </div>

              <!-- Security Warning -->
              <div style="background-color: #1e1b4b; border-left: 4px solid #6366f1; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 12px; color: #c7d2fe; line-height: 1.5;">
                  <strong>Security Note:</strong> Never share this code with anyone. Daraz SupplierDesk staff will never ask for your verification code.
                </p>
              </div>

              <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
                If you did not request this verification code, please ignore this email or change your account password if you suspect unauthorized activity.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px 24px 32px; border-top: 1px solid #334155; text-align: center; font-size: 11px; color: #64748b;">
              <p style="margin: 0 0 6px 0;">Daraz SupplierDesk Multi-Channel Inventory & Order Management</p>
              <p style="margin: 0;">Sent automatically to <strong>${to}</strong></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  // Primary send attempt
  try {
    const transporter = createTransporter(config);
    const info = await transporter.sendMail({
      from: config.from,
      to,
      subject: `${otp} is your Daraz SupplierDesk verification code`,
      text: `Hello ${recipientName},\n\nYour verification code is: ${otp}\n\nThis code will expire in 10 minutes.\nIf you did not request this code, you can safely ignore this email.\n\n- Daraz SupplierDesk`,
      html: htmlContent
    });

    console.log(`[SMTP] Successfully sent OTP email to ${to} (Message ID: ${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err: any) {
    // If TLS protocol mismatch occurred, retry automatically with inverted secure setting
    if (isTlsProtocolMismatchError(err)) {
      console.warn(`[SMTP] Encountered TLS protocol mismatch. Attempting automatic recovery with secure=${!config.secure}...`);
      try {
        const retryTransporter = createTransporter(config, !config.secure);
        const info = await retryTransporter.sendMail({
          from: config.from,
          to,
          subject: `${otp} is your Daraz SupplierDesk verification code`,
          text: `Hello ${recipientName},\n\nYour verification code is: ${otp}\n\nThis code will expire in 10 minutes.\n\n- Daraz SupplierDesk`,
          html: htmlContent
        });

        // Persist the auto-corrected secure flag
        try {
          const cfg = await getConfig();
          cfg.smtp_secure = !config.secure;
          await saveConfig(cfg);
        } catch (_) {}

        console.log(`[SMTP] Recovery succeeded! Sent OTP email to ${to} (Message ID: ${info.messageId})`);
        return { sent: true, messageId: info.messageId };
      } catch (retryErr: any) {
        console.error(`[SMTP] Auto-retry also failed for ${to}:`, retryErr);
        return { sent: false, error: formatFriendlySmtpError(retryErr, config) };
      }
    }

    console.error(`[SMTP] Failed to send OTP email to ${to}:`, err);
    return { sent: false, error: formatFriendlySmtpError(err, config) };
  }
}

export async function testSmtp(customConfig?: Partial<SmtpConfig>, targetEmail?: string): Promise<{
  success: boolean;
  message: string;
  error?: string;
  autoCorrected?: boolean;
  correctedSecure?: boolean;
}> {
  try {
    let config: SmtpConfig | null = null;
    if (customConfig && customConfig.host && customConfig.user && customConfig.pass) {
      const port = Number(customConfig.port) || 587;
      config = {
        host: String(customConfig.host).trim(),
        port,
        secure: determineSmtpSecure(port, customConfig.secure),
        user: String(customConfig.user).trim(),
        pass: String(customConfig.pass).trim(),
        from: String(customConfig.from || '').trim() || `Daraz SupplierDesk <${customConfig.user}>`
      };
    } else {
      config = await getActiveSmtpConfig();
    }

    if (!config) {
      return {
        success: false,
        message: 'No SMTP configuration provided or saved.',
        error: 'Please enter SMTP Host, Port, Username, and Password.'
      };
    }

    let activeSecure = config.secure;
    let didAutoCorrect = false;

    // Verify connection with primary settings
    try {
      const transporter = createTransporter(config, activeSecure);
      await transporter.verify();
    } catch (primaryErr: any) {
      // If TLS record header / wrong version error, attempt auto-correction
      if (isTlsProtocolMismatchError(primaryErr)) {
        console.warn(`[SMTP Test] Protocol mismatch detected (${primaryErr.message}). Auto-testing opposite secure mode (${!activeSecure})...`);
        const fallbackSecure = !activeSecure;
        try {
          const fallbackTransporter = createTransporter(config, fallbackSecure);
          await fallbackTransporter.verify();
          // Auto-correction succeeded!
          activeSecure = fallbackSecure;
          didAutoCorrect = true;
          config.secure = fallbackSecure;

          // Automatically persist the corrected secure flag to config
          try {
            const cfg = await getConfig();
            if (cfg.smtp_host) {
              cfg.smtp_secure = fallbackSecure;
              await saveConfig(cfg);
            }
          } catch (_) {}
        } catch (secondaryErr: any) {
          // If secondary also fails, return friendly error explanation
          return {
            success: false,
            message: 'Failed to connect to SMTP server.',
            error: formatFriendlySmtpError(primaryErr, config)
          };
        }
      } else {
        return {
          success: false,
          message: 'Failed to connect to SMTP server.',
          error: formatFriendlySmtpError(primaryErr, config)
        };
      }
    }

    // If targetEmail is provided, send a live test message
    if (targetEmail && targetEmail.trim()) {
      const transporter = createTransporter(config, activeSecure);
      await transporter.sendMail({
        from: config.from,
        to: targetEmail.trim(),
        subject: '✓ Daraz SupplierDesk - SMTP Email Delivery Verified',
        text: 'Congratulations! Your SMTP email server configuration in Daraz SupplierDesk is working correctly.',
        html: `
          <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 8px; border: 1px solid #334155;">
            <h2 style="color: #22c55e; margin-top: 0;">✓ SMTP Email Delivery Verified!</h2>
            <p>Your Daraz SupplierDesk email configuration is verified and ready to deliver real OTP verification codes and alerts to user inboxes.</p>
            <div style="background: #1e293b; padding: 12px; border-radius: 6px; font-size: 13px; color: #94a3b8; margin-top: 16px;">
              <div><strong>Host:</strong> ${config.host}</div>
              <div><strong>Port:</strong> ${config.port}</div>
              <div><strong>Encryption:</strong> ${activeSecure ? 'SSL / TLS Direct' : 'STARTTLS'}</div>
              <div><strong>Sender:</strong> ${config.from}</div>
            </div>
          </div>
        `
      });

      return {
        success: true,
        message: didAutoCorrect
          ? `Connected & test email delivered! (Note: Auto-adjusted SSL mode to match port ${config.port})`
          : `SMTP connection verified and test email delivered to ${targetEmail}!`,
        autoCorrected: didAutoCorrect,
        correctedSecure: activeSecure
      };
    }

    return {
      success: true,
      message: didAutoCorrect
        ? `Connected to ${config.host}:${config.port} successfully! (Note: Auto-adjusted SSL mode to match port ${config.port})`
        : `SMTP connection to ${config.host}:${config.port} verified successfully!`,
      autoCorrected: didAutoCorrect,
      correctedSecure: activeSecure
    };
  } catch (err: any) {
    console.error('[SMTP] Test connection failed:', err);
    return {
      success: false,
      message: 'Failed to connect to SMTP server.',
      error: err?.message || String(err)
    };
  }
}
