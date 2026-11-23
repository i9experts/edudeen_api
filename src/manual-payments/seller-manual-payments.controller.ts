/* eslint-disable prettier/prettier */
import { All, Controller, GoneException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

/** Text of the 410 every retired seller direct-bank-transfer route answers. */
export const SELLER_MANUAL_PAYMENTS_GONE =
  'Bank transfers are now paid to Edudeen and confirmed by the Edudeen team — sellers no longer set up or confirm direct payments.';

/**
 * RETIRED: seller direct bank transfer (settings + confirming proofs). Bank transfers are paid into the PLATFORM
 * account and confirmed by an admin, who credits the seller's wallet. Every method on every path under
 * /api/seller/manual-payments answers 410 Gone with the same message - before auth or body validation, so old
 * clients always get the same clear answer (never 400/403/404). Stored Store.directPayment data is untouched.
 */
@ApiExcludeController()
@Controller('api/seller/manual-payments')
export class SellerManualPaymentsController {
  @All()
  root(): never {
    throw new GoneException(SELLER_MANUAL_PAYMENTS_GONE);
  }

  @All('*path')
  any(): never {
    throw new GoneException(SELLER_MANUAL_PAYMENTS_GONE);
  }
}
