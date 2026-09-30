/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { OtpService } from './otp.service';

describe('OtpService.sendOtp', () => {
  const make = (cfg: Record<string, string>) => {
    const svc: any = new OtpService({ get: (k: string) => cfg[k] } as any);
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'mid-1', response: '250 OK to victim@x.co' });
    svc.transporter = { sendMail };
    const log = jest.spyOn(svc.logger, 'log').mockImplementation(() => undefined);
    return { svc, sendMail, log };
  };

  it('sends from the configured sender, never a hard-coded personal address', async () => {
    const { svc, sendMail } = make({ SMTP_USER: 'noreply@edudeen.com', SMTP_FROM: 'Edudeen <noreply@edudeen.com>' });
    await svc.sendOtp('buyer@x.co', '123456');
    expect(sendMail.mock.calls[0][0].from).toBe('Edudeen <noreply@edudeen.com>');
    const { svc: s2, sendMail: m2 } = make({ SMTP_USER: 'smtp-user@edudeen.com' });
    await s2.sendOtp('buyer@x.co', '123456');
    expect(m2.mock.calls[0][0].from).toBe('smtp-user@edudeen.com');
  });

  it('does not write the recipient address or the SMTP response to the log', async () => {
    const { svc, log } = make({ SMTP_USER: 'a@b.co' });
    await svc.sendOtp('victim@x.co', '123456');
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('victim@x.co');
    expect(logged).not.toContain('123456');
  });
});
