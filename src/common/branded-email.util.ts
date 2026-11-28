/** Shared EDUDEEN email shell (white logo header, card body, optional button, footer) for transactional
 *  emails built in code. Same table-based, inline-styled layout as otpEmailHtml so it renders in Gmail's
 *  app and Outlook, which strip <style> blocks. `bodyHtml` is inserted as-is: escape any user data first. */
export function escapeEmailText(
  value: string | number | null | undefined,
): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

export function brandedEmailHtml(opts: {
  title: string;
  /** Inbox preview line (hidden in the body). */
  preheader?: string;
  bodyHtml: string;
  button?: { label: string; url: string };
  /** Small grey line under the button, e.g. "If you weren't expecting this email, you can ignore it." */
  note?: string;
}): string {
  const { title, preheader, bodyHtml, button, note } = opts;
  const year = new Date().getFullYear();
  const t = escapeEmailText(title);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t}</title>
</head>
<body style="margin:0; padding:0; background:#F5F8FA; font-family:Arial, Helvetica, sans-serif;">
${preheader ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:#F5F8FA;">${escapeEmailText(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F8FA; padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background:#FFFFFF; border-radius:12px; overflow:hidden; border:1px solid #E1E7EA;">
        <tr>
          <td style="background:#FFFFFF; border-bottom:1px solid #E1E7EA; padding:24px 32px; text-align:center;">
            <img src="https://edudeen.com/edudeen-logo-640.png" width="140" alt="EDUDEEN" style="display:block; margin:0 auto; max-width:140px; height:auto;">
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 8px;">
            <h1 style="margin:0 0 16px; font-family:Georgia, 'Times New Roman', serif; font-weight:normal; font-size:26px; line-height:1.25; color:#152D43;">${t}</h1>
            <div style="font-size:15px; line-height:1.65; color:#1F3A52;">${bodyHtml}</div>
          </td>
        </tr>
        ${
          button
            ? `<tr>
          <td style="padding:20px 32px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="background:#174771; border-radius:8px;">
                <a href="${escapeEmailText(button.url)}" style="display:inline-block; padding:14px 28px; font-size:15px; font-weight:bold; color:#FFFFFF; text-decoration:none;">${escapeEmailText(button.label)}</a>
              </td>
            </tr></table>
            <p style="margin:12px 0 0; font-size:12px; line-height:1.6; color:#5B6973;">Button not working? Copy this link into your browser:<br><a href="${escapeEmailText(button.url)}" style="color:#2F6AA8; word-break:break-all;">${escapeEmailText(button.url)}</a></p>
          </td>
        </tr>`
            : ''
        }
        ${
          note
            ? `<tr>
          <td style="padding:16px 32px 0;">
            <p style="margin:0; font-size:13px; line-height:1.6; color:#5B6973;">${escapeEmailText(note)}</p>
          </td>
        </tr>`
            : ''
        }
        <tr>
          <td style="padding:28px 32px 0;"><div style="height:4px; line-height:4px; font-size:0; background:#66AD36; border-radius:2px; width:56px;">&nbsp;</div></td>
        </tr>
        <tr>
          <td style="padding:16px 32px 28px;">
            <p style="margin:0; font-size:12px; line-height:1.6; color:#5B6973;">© ${year} EDUDEEN · <a href="https://edudeen.com" style="color:#5B6973;">edudeen.com</a></p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
