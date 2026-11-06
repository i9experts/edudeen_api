/* eslint-disable prettier/prettier */
/**
 * Static English copy of the web guides (edudeen_web/src/features/buyer/pages/guide/guideData.ts),
 * used only for the crawler HTML of /sitemap. Titles/summaries/points mirror the web data; keep in sync by hand.
 */
export interface GuideStepCopy { id: string; title: string; summary: string; points: string[] }
export interface GuideSectionCopy { id: string; title: string; intro: string; steps: GuideStepCopy[] }

export const BUYER_GUIDE: GuideSectionCopy[] = [
  {
    id: 'buyer-shop', title: 'Find and choose', intro: 'From the home page to the right resource in about a minute.',
    steps: [
      { id: 'b-find', title: 'Browse by class or subject', summary: 'Pick a class, a subject or type in the search box.', points: [
        'Use the class tiles or the Shop by subject menu on the home page.',
        'Search understands Urdu, Roman Urdu and small spelling mistakes.',
        'Filters: class, price, rating, free only, online courses. Sort by newest, price or rating.',
        'Tap the heart to save a product, or Compare to put up to 4 side by side.',
      ] },
      { id: 'b-product', title: 'Read the product page', summary: 'Photos, what you get, class, delivery and the seller.', points: [
        '"What you get" shows file type, pages and language. Courses show lessons and duration.',
        'Check the seller card: store name, rating and reply time.',
        'Delivery row: digital items are instant; physical items show the delivery charge and whether Cash on Delivery is possible.',
        'Reviews from real buyers are under the product. Only people who bought it can review.',
      ] },
    ],
  },
  {
    id: 'buyer-buy', title: 'Buy safely', intro: 'Cart, checkout and the three ways to pay.',
    steps: [
      { id: 'b-cart', title: 'Add to cart', summary: 'Items from several stores can sit in one cart.', points: [
        'Change quantity or remove an item. Removing shows an Undo for 5 seconds.',
        'Free products use the "Avail for free" button instead of the cart.',
        'Buy Now skips the cart and checks out one item only.',
      ] },
      { id: 'b-checkout', title: 'Checkout and pay', summary: 'Address (physical only), delivery, payment, review, place order.', points: [
        'Digital-only carts skip the address step.',
        'Card: works on USD prices. Bank transfer / wallet: send money to the Edudeen account shown, then upload the receipt. COD: pay the courier when your parcel arrives.',
        'Bank transfer orders become "paid" after the Edudeen team checks your receipt (usually within a day).',
        'Coupons, gift cards and gift wrap can be added before you pay.',
        'Upload a clear photo or PDF of the receipt (jpg, png, webp, heic or pdf).',
        'Do not pay twice. A duplicate card payment is refunded automatically.',
      ] },
      { id: 'b-success', title: 'Order placed', summary: 'You see your order number, a Download button for digital items and what happens next.', points: [
        'You also get an in-app notification and an e-mail.',
        'Closed the tab? Your order is always in Account > Orders.',
      ] },
    ],
  },
  {
    id: 'buyer-after', title: 'After you buy', intro: 'Download, track, review and get help.',
    steps: [
      { id: 'b-library', title: 'Downloads and My Library', summary: 'Every file and course you own, in one place.', points: [
        'Filter by type, sort, or show the last 30 days.',
        'Link expired? Press "Re-send download link".',
        'Online courses open in the course player. You get a certificate when you finish.',
      ] },
      { id: 'b-orders', title: 'Track orders', summary: 'Status line shows placed, packed, shipped, delivered.', points: [
        'Each seller\'s parcel has its own status and tracking link.',
        'With COD you pay per parcel when it arrives.',
      ] },
      { id: 'b-refund', title: 'Refunds and returns', summary: 'Open the order and press the refund request on the item.', points: [
        'Digital files: refundable only if you have not downloaded them.',
        'Physical items: after delivery. Choose a reason, write a short note (20+ characters) and add up to 3 photos if damaged.',
        'The seller and Edudeen review your request. You are notified of the decision.',
      ] },
      { id: 'b-account', title: 'Your account', summary: 'Profile, addresses, notifications, children, Premium.', points: [
        'My children: add up to 8 children and shop by their class.',
        'Edudeen Premium: member prices on many products and early access to sales.',
        'Notifications: choose which updates you want. Reminders by WhatsApp/SMS are coming soon.',
      ] },
    ],
  },
];

export const SELLER_GUIDE: GuideSectionCopy[] = [
  {
    id: 'seller-start', title: 'Open your store', intro: 'Account to a live store in about 10 minutes. You need your logo and a short description ready.',
    steps: [
      { id: 's-register', title: 'Create your seller account', summary: 'Choose Seller on the sign-up page and verify your e-mail.', points: [
        'Already a buyer? Open the profile menu > Sell on Edudeen. Your e-mail and password stay the same.',
        'Enter the 6-digit code sent to your e-mail.',
      ] },
      { id: 's-plan', title: 'Choose a plan', summary: 'Monthly or yearly plans; a free trial may be available once per seller.', points: [
        'Edudeen also takes a small platform fee on each sale (set by Edudeen, shown in your earnings).',
        'Free trial: no card needed. When it ends your listings are hidden until you pick a plan; they come back when a plan is active.',
      ] },
      { id: 's-store', title: 'Onboarding: 5 short steps', summary: 'Store Info, Plan & Payment, Seller Type, What You Sell, Review.', points: [
        'Store name and short description (required). 30+ characters of bio helps you appear in Featured sellers.',
        'Logo and cover (recommended): a square logo and a wide cover.',
        'Plan & Payment: card for paid plans. The free trial skips this step.',
        'Seller type: Creator, Educator, Bookseller, Publisher/Institute, Tutor or Mix.',
        'Your store goes live immediately after you finish. Products still need a quick check before they show.',
      ] },
      { id: 's-dash', title: 'Finish the setup checklist', summary: 'The dashboard shows what is left: profile, first product, payout method.', points: [
        '"Action required" lists orders to ship, returns, messages and questions waiting for you.',
        'Add a payout method now so you are ready when your first sale clears.',
      ] },
    ],
  },
  {
    id: 'seller-product', title: 'Upload a product', intro: 'Add Product is a 6-step guide. Steps show Required or Optional. You can save a draft at any time, so nothing is lost.',
    steps: [
      { id: 's-p1', title: 'Step 1 · Type & basics', summary: 'Physical (you ship) or Digital (buyers download). You cannot change this after publishing.', points: [
        'Product title (required): at least 10 characters, start with a capital letter, e.g. "Class 5 Mathematics Worksheets Bundle".',
        'Description (required): at least 20 characters: what is included, the learning goal, how to use it.',
        'Avoid phone numbers, WhatsApp, e-mail or links in the text. The listing is then held for manual review.',
      ] },
      { id: 's-p2', title: 'Step 2 · Photos & files', summary: 'Pictures buyers see, and the files they receive.', points: [
        'Photos (optional): up to 20. Drag to reorder. The first photo is the cover.',
        'Your files (digital, required): PDF, audio, video or a ZIP. Online courses use the Course builder.',
        'Free sample (digital, required to publish, not for drafts): Edudeen builds a stamped preview from it.',
      ] },
      { id: 's-p3', title: 'Step 3 · Price & stock', summary: 'Price in your store currency. Enter 0 for a free resource.', points: [
        'Price (required): PKR in whole rupees. A strike-through "compare at" price must be higher than the price.',
        'Stock quantity (physical, required): whole number, 0 to 100,000, or Unlimited.',
        'Shipping weight (physical, required): used for the delivery charge, 1 g to 50 kg.',
        'Licence, download limit and link expiry (digital, optional).',
      ] },
      { id: 's-p4', title: 'Step 4 · Category & details', summary: 'Where it appears and who it is for.', points: [
        'Category and sub-category (required).',
        'Product card style (required): book look or plain photo.',
        'Class range (required to publish digital products), e.g. Class 3 to Class 5.',
        'Board, age, language and tags are optional.',
      ] },
      { id: 's-p5', title: 'Step 5 · Offers & earnings', summary: 'Optional. Join a platform sale or give Premium members a discount.', points: [
        'A product can be in a platform sale or have a Premium discount, not both.',
        'The calculator shows what you earn after the platform fee.',
      ] },
      { id: 's-p6', title: 'Step 6 · Review & publish', summary: 'Missing items are listed with a link to fix them.', points: [
        'Publish now, Schedule a date (Pakistan time), or Save draft.',
        'Your first listings are checked by the Edudeen team, usually within a day. Paid plans publish directly.',
        'A live preview card shows exactly how buyers will see it.',
      ] },
      { id: 's-bulk', title: 'Many products at once: Bulk upload', summary: 'Drop up to 50 files, fill one row per product, create them all.', points: [
        'Choose Digital or Physical. Cover photos are matched by file name.',
        'Rows with problems stay red and are not created. Your work is auto-saved on this device.',
      ] },
    ],
  },
  {
    id: 'seller-sell', title: 'Run your orders', intro: 'From a new order to money in your wallet.',
    steps: [
      { id: 's-orders', title: 'New orders', summary: 'Orders to ship are counted on your dashboard and in the Orders menu.', points: [
        'Open an order, pack it, add tracking and press Mark shipped. Ship within 48 hours of payment to keep your Store Health high.',
        'Digital orders are delivered automatically.',
      ] },
      { id: 's-ship', title: 'Delivery settings', summary: 'Set where you ship from and how you charge delivery.', points: [
        'Store Settings > Ships from (city and province) gives correct delivery charges.',
        'You can charge your own flat fee or free over an amount, offer gift wrap, and allow Cash on Delivery.',
      ] },
      { id: 's-cod', title: 'Cash on Delivery', summary: 'Cash is confirmed per parcel after it is shipped.', points: [
        'When your own rider collects the cash, press Mark paid after delivery. Edudeen then deducts its platform fee from your wallet.',
        'If Edudeen collects the cash, you are credited after Edudeen receives it.',
      ] },
      { id: 's-money', title: 'Earnings and payouts', summary: 'Sales go to your wallet, then you request a payout.', points: [
        'Each paid sale is credited minus the platform fee, and clears after a few days.',
        'Add a payout method (bank or wallet). Only the last 4 digits of the account number are shown afterwards.',
        'Request a payout. The Edudeen team approves and sends it.',
      ] },
    ],
  },
  {
    id: 'seller-grow', title: 'Grow your store', intro: 'Optional tools once your first products are live.',
    steps: [
      { id: 's-custom', title: 'Customize your store', summary: 'Pick featured products, show New arrivals and Best sellers.', points: ['Save a draft, preview on phone and desktop, then Publish.'] },
      { id: 's-mkt', title: 'Marketing and platform sales', summary: 'Join Edudeen sales, make coupons and discounts.', points: ['Apply now on a running sale and tick the products to include.'] },
      { id: 's-health', title: 'Store Health', summary: 'Late dispatch, returns, reply speed and rating against targets.', points: ['Numbers appear after 10 samples so they are fair.'] },
      { id: 's-students', title: 'Students and downloads', summary: 'See who bought your courses and files, and export a list.', points: [] },
    ],
  },
];

/** Crawler HTML for both guides. `esc` is the shared HTML escaper. */
export function guideHtml(esc: (v: unknown) => string, origin: string): string {
  const render = (tab: 'buyer' | 'seller', heading: string, sections: GuideSectionCopy[]) =>
    `<section><h2>${esc(heading)}</h2>`
    + sections.map((s) => `<section><h3>${esc(s.title)}</h3><p>${esc(s.intro)}</p>`
      + s.steps.map((st) => `<article id="${esc(st.id)}"><h4><a href="${origin}/sitemap?tab=${tab}#${esc(st.id)}">${esc(st.title)}</a></h4><p>${esc(st.summary)}</p>`
        + (st.points.length ? `<ul>${st.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '') + '</article>').join('')
      + '</section>').join('')
    + '</section>';
  return render('buyer', 'Buyer guide', BUYER_GUIDE) + render('seller', 'Seller guide', SELLER_GUIDE);
}
