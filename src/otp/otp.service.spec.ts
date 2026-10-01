/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
// OTP mail goes through the shared mailer (src/common/mailer.util), which picks the
// sender from SMTP_FROM / SMTP_USER (never a hard-coded personal address).
const sendMail = jest.fn();
jest.mock('src/common/mailer.util', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));

import { OtpService } from './otp.service';

describe('OtpService.sendOtp', () => {
  const make = () => {
    const svc: any = new OtpService();
    const log = jest.spyOn(svc.logger, 'log').mockImplementation(() => undefined);
    const err = jest.spyOn(svc.logger, 'error').mockImplementation(() => undefined);
    return { svc, log, err };
  };

  beforeEach(() => sendMail.mockReset());

  it('sends the code to the recipient through the shared mailer', async () => {
    sendMail.mockResolvedValue('mid-1');
    const { svc } = make();
    await svc.sendOtp('buyer@x.co', '123456');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('buyer@x.co');
    expect(sendMail.mock.calls[0][0].html).toContain('123456');
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('from');
  });

  it('does not write the recipient address or the code to the log', async () => {
    sendMail.mockResolvedValue('mid-1');
    const { svc, log } = make();
    await svc.sendOtp('victim@x.co', '123456');
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('victim@x.co');
    expect(logged).not.toContain('123456');
  });

  it('logs the failure cause without the recipient, then throws', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    const { svc, err } = make();
    await expect(svc.sendOtp('victim@x.co', '123456')).rejects.toThrow('Failed to send OTP email');
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('EAUTH');
    expect(logged).not.toContain('victim@x.co');
  });
});
