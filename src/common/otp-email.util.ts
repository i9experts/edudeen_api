/** Shared OTP/verification-code email body, used by both OtpService.sendOtp (the real path, called
 *  from AuthService for login/signup/password-reset) and EmailService.sendOtpEmail. Table-based
 *  layout with inline styles throughout (not a <head><style> block) — the most broadly compatible
 *  pattern across email clients that strip <style> blocks (Gmail's app, older Outlook). Brand colors/
 *  logo match Edudeen's own app (src/index.css --color-brand-*). */
export function otpEmailHtml(opts: {
  appName: string;
  title: string;
  message: string;
  otp: string;
  expiryMinutes: number;
}): string {
  const { appName, title, message, otp, expiryMinutes } = opts;
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
</head>
<body style="margin:0; padding:0; background:#F5F8FA; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F8FA; padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="100%" style="max-width:520px; background:#FFFFFF; border-radius:12px; overflow:hidden;">
                    <tr>
                        <td style="background:#174771; padding:24px 32px; text-align:center;">
                            <img src="https://edudeen.com/edudeen-logo-640.png" width="140" alt="${appName}" style="display:block; margin:0 auto; max-width:140px; height:auto;">
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:36px 32px 8px;">
                            <h1 style="margin:0 0 12px; font-size:22px; line-height:1.3; color:#152D43; text-align:center;">${title}</h1>
                            <p style="margin:0; font-size:15px; line-height:1.6; color:#5B6973; text-align:center;">${message}</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 32px;">
                            <table role="presentation" width="100%" style="background:#F5F8FA; border:1px solid #E1E7EA; border-radius:10px;">
                                <tr>
                                    <td style="padding:24px; text-align:center;">
                                        <div style="font-size:13px; color:#5B6973; margin-bottom:10px;">Your verification code</div>
                                        <div style="font-size:34px; font-weight:bold; letter-spacing:8px; color:#174771;">${otp}</div>
                                        <div style="font-size:13px; color:#5B6973; margin-top:10px;">Valid for ${expiryMinutes} minutes</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0 32px 24px;">
                            <table role="presentation" width="100%" style="background:#FEF7E5; border-left:4px solid #CCB000; border-radius:6px;">
                                <tr>
                                    <td style="padding:14px 16px; font-size:13px; line-height:1.6; color:#152D43;">
                                        <strong>Security notice</strong>
                                        <ul style="margin:8px 0 0; padding-left:18px;">
                                            <li>Never share this code with anyone</li>
                                            <li>The Edudeen team will never ask for your code</li>
                                            <li>It expires in ${expiryMinutes} minutes</li>
                                        </ul>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0 32px 32px; text-align:center;">
                            <p style="margin:0; font-size:13px; color:#5B6973;">If you didn't request this code, you can safely ignore this email.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:20px 32px; border-top:1px solid #E1E7EA; text-align:center;">
                            <p style="margin:0; font-size:12px; color:#5B6973;">© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                            <p style="margin:4px 0 0; font-size:12px; color:#5B6973;">This is an automated email — please don't reply to it.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;
}
