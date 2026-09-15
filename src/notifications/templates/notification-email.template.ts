const APP_NAME = process.env.APP_NAME || 'Edudeen';
const BRAND_COLOR = '#d97757';

/**
 * Modern shared shell for every Notifications-module email — a text wordmark
 * (no external logo asset dependency) in the app's brand color, a rounded
 * card body, and an optional pill CTA button. Kept separate from the older
 * `shell()` helper in subscription-notifications.service.ts /
 * platform-plan-notifications.service.ts, which is out of scope here.
 */
export function notificationEmailShell(
  title: string,
  bodyHtml: string,
  cta?: { label: string; url: string },
): string {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #2b2b2b;
    background: #f5f2ef;
    max-width: 600px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  .wordmark {
    text-align: center;
    padding: 8px 0 24px;
  }
  .wordmark span {
    font-weight: 800;
    font-size: 28px;
    letter-spacing: -0.5px;
    color: ${BRAND_COLOR};
  }
  .card {
    background: #ffffff;
    border-radius: 16px;
    padding: 36px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  .card h1 {
    margin: 0 0 16px;
    font-size: 21px;
    color: #1f1f1f;
  }
  .box {
    background: #f8f6f4;
    border-radius: 12px;
    padding: 18px 20px;
    margin: 20px 0;
  }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .label { color: #767676; }
  .value { font-weight: 600; color: #222; }
  .cta {
    display: inline-block;
    margin: 24px 0 8px;
    padding: 12px 28px;
    background: ${BRAND_COLOR};
    color: #ffffff !important;
    text-decoration: none;
    border-radius: 999px;
    font-weight: 600;
    font-size: 14px;
  }
  .footer {
    text-align: center;
    margin-top: 28px;
    color: #9a9a9a;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div class="wordmark"><span>${APP_NAME}</span></div>
  <div class="card">
    <h1>${title}</h1>
    ${bodyHtml}
    ${cta ? `<div style="text-align:center"><a class="cta" href="${cta.url}">${cta.label}</a></div>` : ''}
  </div>
  <div class="footer">
    <p>&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
    <p>You're receiving this because of activity on your ${APP_NAME} account. Manage preferences in the app under Notifications.</p>
  </div>
</body>
</html>`;
}
