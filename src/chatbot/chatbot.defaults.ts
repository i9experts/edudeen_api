/* eslint-disable prettier/prettier */
/**
 * Built-in content of the Edudeen Help chat widget. ONE source of truth for the API; the web app mirrors it in
 * `edudeen_web/src/components/chat/chatbotDefaults.ts` (used while the config loads and when the API is down).
 * Admin edits (PlatformConfig.chatbot) replace these lists; an empty/missing list falls back to these defaults.
 *
 * Answers use a tiny markdown subset: **bold**, [label](/internal-path) or [label](https://...), and newlines.
 * Seller links use the /seller/... redirects so they work without knowing the store id.
 */

export type ChatAudience = 'buyer' | 'seller';

export interface ChatQA {
  id: string;
  q: string;
  a: string;
  qUr?: string;
  aUr?: string;
  /** Roman Urdu (Urdu written in Latin letters) variants - used when the visitor types in Roman Urdu. */
  qRu?: string;
  aRu?: string;
}

export interface ChatbotConfig {
  enabled: boolean;
  /** Allow the existing AI help-bot (kill switch `help_bot` in AI settings still applies) for free-text questions. */
  aiEnabled: boolean;
  /** false (default): a typed question that is not a greeting/FAQ goes to the admin chat inbox. true: the AI help-bot answers it instead. */
  useAiFallback: boolean;
  buyerQuestions: ChatQA[];
  sellerQuestions: ChatQA[];
  welcomeText: string;
  welcomeTextUr: string;
  fallbackText: string;
  fallbackTextUr: string;
}

/** Number of suggested questions shown as chips per audience. More entries stay searchable (FAQ matcher). */
export const CHIP_COUNT = 5;

export const DEFAULT_BUYER_QUESTIONS: ChatQA[] = [
  {
    id: 'buyer-download',
    q: 'How do I download my purchase?',
    a: 'Once your payment is confirmed, your files appear in **My Library** ([Account > Downloads](/account/downloads)). Open it and tap **Download** next to the item.\nCan\'t find the link or it expired? Use **Resend download link** on that page and we will email it to you.\nFor bank-transfer orders, files unlock after our team approves your receipt.',
    qUr: 'میں اپنی خریداری کیسے ڈاؤن لوڈ کروں؟',
    aUr: 'ادائیگی کی تصدیق ہوتے ہی آپ کی فائلیں **My Library** ([اکاؤنٹ > ڈاؤن لوڈز](/account/downloads)) میں آ جاتی ہیں۔ وہاں آئٹم کے ساتھ **Download** دبائیں۔\nلنک نہ ملے یا ختم ہو جائے تو اسی صفحے پر **Resend download link** دبائیں، لنک آپ کی ای میل پر بھیج دیا جائے گا۔\nبینک ٹرانسفر کی صورت میں ہماری ٹیم کے رسید منظور کرنے کے بعد فائلیں کھلتی ہیں۔',
  },
  {
    id: 'buyer-pay',
    q: 'How can I pay?',
    a: 'At checkout you will see the methods available for your order:\n**Bank transfer / mobile wallet** - send the amount to Edudeen\'s account shown at checkout, then upload your receipt. Our team approves it and your order is confirmed.\n**Card** - on USD checkouts where card payment is enabled.\n**Cash on delivery** - on physical orders where it is offered.\nStart from [your cart](/cart).',
    qUr: 'میں ادائیگی کیسے کروں؟',
    aUr: 'چیک آؤٹ پر آپ کو اپنے آرڈر کے لیے دستیاب طریقے نظر آئیں گے:\n**بینک ٹرانسفر / موبائل والیٹ** - چیک آؤٹ پر دکھائے گئے ایڈودین کے اکاؤنٹ میں رقم بھیجیں اور رسید اپ لوڈ کریں۔ ہماری ٹیم منظور کرے تو آرڈر کنفرم ہو جاتا ہے۔\n**کارڈ** - ان USD چیک آؤٹس پر جہاں کارڈ پیمنٹ فعال ہو۔\n**کیش آن ڈیلیوری** - فزیکل آرڈرز پر جہاں یہ دستیاب ہو۔\nشروع کرنے کے لیے [اپنا کارٹ](/cart) کھولیں۔',
  },
  {
    id: 'buyer-track',
    q: 'How do I track my order and what happens after I order?',
    a: 'After you order: payment is confirmed (right away for card, after receipt approval for bank transfer), the seller prepares your order, it ships with tracking, then it is delivered.\nDigital items unlock as soon as payment is confirmed.\nFollow every step in [Account > Orders](/account/orders). We also notify you when the status changes.',
    qUr: 'میں اپنا آرڈر کیسے ٹریک کروں اور آرڈر کے بعد کیا ہوتا ہے؟',
    aUr: 'آرڈر کے بعد: ادائیگی کی تصدیق ہوتی ہے (کارڈ پر فوراً، بینک ٹرانسفر پر رسید منظور ہونے کے بعد)، سیلر آرڈر تیار کرتا ہے، ٹریکنگ کے ساتھ شپ ہوتا ہے، پھر ڈیلیور ہو جاتا ہے۔\nڈیجیٹل آئٹمز ادائیگی کی تصدیق ہوتے ہی کھل جاتے ہیں۔\nہر مرحلہ [اکاؤنٹ > آرڈرز](/account/orders) میں دیکھیں۔ اسٹیٹس بدلنے پر ہم آپ کو اطلاع بھی دیتے ہیں۔',
  },
  {
    id: 'buyer-refund',
    q: 'Can I get a refund or return?',
    a: '**Digital items** can be refunded only if you have not downloaded them yet.\n**Physical items** can be returned or refunded after delivery.\nOpen the order in [Account > Orders](/account/orders) and choose **Request refund** for the item. Each seller\'s return policy is shown on the product page, and our team reviews every request.',
    qUr: 'کیا مجھے ریفنڈ یا واپسی مل سکتی ہے؟',
    aUr: '**ڈیجیٹل آئٹمز** کا ریفنڈ صرف تب ممکن ہے جب آپ نے انہیں ڈاؤن لوڈ نہ کیا ہو۔\n**فزیکل آئٹمز** ڈیلیوری کے بعد واپس یا ریفنڈ کیے جا سکتے ہیں۔\n[اکاؤنٹ > آرڈرز](/account/orders) میں آرڈر کھول کر آئٹم کے لیے **Request refund** چنیں۔ ہر سیلر کی ریٹرن پالیسی پروڈکٹ پیج پر نظر آتی ہے اور ہماری ٹیم ہر درخواست کا جائزہ لیتی ہے۔',
  },
  {
    id: 'buyer-premium',
    q: 'What is Edudeen Premium?',
    a: '**Edudeen Premium** is a membership with extra savings: member prices from sellers plus an Edudeen discount on eligible items, early access to sales, a personal coupon and priority support.\nSee the plans and join on the [Premium page](/premium).',
    qUr: 'ایڈودین پریمیم کیا ہے؟',
    aUr: '**ایڈودین پریمیم** ایک ممبرشپ ہے جس میں اضافی بچت ملتی ہے: سیلرز کی طرف سے ممبر قیمتیں اور اہل آئٹمز پر ایڈودین کی طرف سے رعایت، سیلز تک پہلے رسائی، ذاتی کوپن اور ترجیحی سپورٹ۔\nپلانز دیکھنے اور شامل ہونے کے لیے [پریمیم صفحہ](/premium) کھولیں۔',
  },
];

export const DEFAULT_SELLER_QUESTIONS: ChatQA[] = [
  {
    id: 'seller-start',
    q: 'How do I start selling and create my store?',
    a: 'Go to [Become a seller](/become-a-seller), choose a **monthly or yearly plan** (a free trial plan may be available), fill in your store details and finish the plan step.\nOur team then reviews and approves your store. You are notified, and after approval you can list products.',
    qUr: 'میں فروخت کیسے شروع کروں اور اپنا اسٹور کیسے بناؤں؟',
    aUr: '[سیلر بنیں](/become-a-seller) کھولیں، **ماہانہ یا سالانہ پلان** چنیں (فری ٹرائل پلان بھی ہو سکتا ہے)، اسٹور کی تفصیلات بھریں اور پلان کا مرحلہ مکمل کریں۔\nپھر ہماری ٹیم آپ کے اسٹور کا جائزہ لے کر منظور کرتی ہے۔ آپ کو اطلاع ملے گی اور منظوری کے بعد آپ پروڈکٹس لسٹ کر سکتے ہیں۔',
  },
  {
    id: 'seller-add-product',
    q: 'How do I add a product?',
    a: 'Open your dashboard, go to **Products > Add product** ([Products](/seller/products)). Pick the type (physical, digital, educational or course), the category and sub-category, then add the title, images or files, description and price.\nTo give Premium members a discount, switch on **Premium discount** in the form. Listings may be reviewed by Edudeen before they go live.',
    qUr: 'میں پروڈکٹ کیسے شامل کروں؟',
    aUr: 'اپنا ڈیش بورڈ کھولیں اور **Products > Add product** پر جائیں ([پروڈکٹس](/seller/products))۔ قسم (فزیکل، ڈیجیٹل، ایجوکیشنل یا کورس)، کیٹیگری اور سب کیٹیگری چنیں، پھر عنوان، تصاویر یا فائلیں، تفصیل اور قیمت شامل کریں۔\nپریمیم ممبرز کو رعایت دینے کے لیے فارم میں **Premium discount** آن کریں۔ لسٹنگ لائیو ہونے سے پہلے ایڈودین اس کا جائزہ لے سکتا ہے۔',
  },
  {
    id: 'seller-payout',
    q: 'How and when do I get paid?',
    a: 'Buyers pay Edudeen, not you. When an order is paid, your earnings (sale price minus the platform fee) are credited to your wallet - first as **pending** for a short clearing period, then **available**.\nRequest a payout from [Finance](/seller/finance); the Edudeen team approves it and sends it to your saved payout account. Add or update your payout method there first.',
    qUr: 'مجھے ادائیگی کیسے اور کب ملے گی؟',
    aUr: 'خریدار ایڈودین کو ادائیگی کرتے ہیں، آپ کو نہیں۔ آرڈر کی ادائیگی ہونے پر آپ کی کمائی (فروخت کی قیمت منفی پلیٹ فارم فیس) آپ کے والیٹ میں جمع ہو جاتی ہے - پہلے مختصر کلیئرنگ مدت کے لیے **pending** اور پھر **available**۔\n[فنانس](/seller/finance) سے پے آؤٹ کی درخواست دیں؛ ایڈودین ٹیم منظور کر کے آپ کے محفوظ کردہ پے آؤٹ اکاؤنٹ میں رقم بھیجتی ہے۔ پہلے وہیں اپنا پے آؤٹ طریقہ شامل یا اپ ڈیٹ کریں۔',
  },
  {
    id: 'seller-fees',
    q: 'What are the platform fees?',
    a: 'Platform fees are set by Edudeen per product type (digital, educational and course items vs physical), as a percentage or a fixed amount per item. They apply to the item price only, never to shipping.\nSales to Premium members use their own Premium fee rate. The product form has a **Your earnings** calculator that shows exactly what you will receive.',
    qUr: 'پلیٹ فارم فیس کتنی ہے؟',
    aUr: 'پلیٹ فارم فیس ایڈودین پروڈکٹ کی قسم (ڈیجیٹل، ایجوکیشنل اور کورس بمقابلہ فزیکل) کے مطابق فیصد یا فی آئٹم مقررہ رقم کی صورت میں طے کرتا ہے۔ یہ صرف آئٹم کی قیمت پر لگتی ہے، شپنگ پر کبھی نہیں۔\nپریمیم ممبرز کو فروخت پر ان کا اپنا پریمیم فیس ریٹ لگتا ہے۔ پروڈکٹ فارم میں **Your earnings** کیلکولیٹر دکھاتا ہے کہ آپ کو بالکل کتنی رقم ملے گی۔',
  },
  {
    id: 'seller-sale',
    q: 'How do I run a sale or offer Premium discounts?',
    a: 'Open [Marketing](/seller/marketing): join running Edudeen **campaigns and flash sales** (you can choose which products join) and create your own discounts. For Premium members, switch on **Premium discount** on a product and set the percentage.\nA normal sale price must stay at least 5 percentage points below the Premium discount - the form tells you if it does not. Some tools depend on your plan.',
    qUr: 'میں سیل یا پریمیم ڈسکاؤنٹ کیسے چلاؤں؟',
    aUr: '[مارکیٹنگ](/seller/marketing) کھولیں: ایڈودین کی جاری **کیمپینز اور فلیش سیلز** میں شامل ہوں (آپ چن سکتے ہیں کون سی پروڈکٹس شامل ہوں) اور اپنے ڈسکاؤنٹس بنائیں۔ پریمیم ممبرز کے لیے پروڈکٹ پر **Premium discount** آن کریں اور فیصد مقرر کریں۔\nعام سیل کی قیمت پریمیم ڈسکاؤنٹ سے کم از کم 5 فیصد پوائنٹ کم رہنی چاہیے - ایسا نہ ہو تو فارم بتا دیتا ہے۔ کچھ ٹولز آپ کے پلان پر منحصر ہیں۔',
  },
];

export const DEFAULT_CHATBOT: ChatbotConfig = {
  enabled: true,
  aiEnabled: true,
  useAiFallback: false,
  buyerQuestions: DEFAULT_BUYER_QUESTIONS,
  sellerQuestions: DEFAULT_SELLER_QUESTIONS,
  welcomeText: 'I am the Edudeen help assistant. Tap a question below or type your own.',
  welcomeTextUr: 'میں ایڈودین کا مددگار ہوں۔ نیچے سے کوئی سوال چنیں یا اپنا سوال لکھیں۔',
  fallbackText: 'Sorry, I could not find an exact answer to that. Try one of the questions below, or contact our support team and we will help you personally.',
  fallbackTextUr: 'معذرت، مجھے اس کا درست جواب نہیں ملا۔ نیچے دیے گئے سوالات میں سے کوئی آزمائیں یا ہماری سپورٹ ٹیم سے رابطہ کریں، ہم آپ کی ذاتی طور پر مدد کریں گے۔',
};

/** Curated Roman Urdu variants of the default questions (merged into the defaults above). */
const ROMAN_URDU: Record<string, { q: string; a: string }> = {
  'buyer-download': {
    q: 'Main apni kharidari kaise download karoon?',
    a: 'Payment confirm hote hi aapki files **My Library** ([Account > Downloads](/account/downloads)) mein aa jati hain. Wahan item ke saath **Download** dabayen.\nLink na mile ya expire ho jaye to usi page par **Resend download link** dabayen, link aapki email par bhej diya jayega.\nBank transfer ki surat mein hamari team ke receipt approve karne ke baad files khulti hain.',
  },
  'buyer-pay': {
    q: 'Main payment kaise karoon?',
    a: 'Checkout par aapko apne order ke liye mojood tareeqe nazar ayenge:\n**Bank transfer / mobile wallet** - checkout par diye gaye Edudeen ke account mein raqam bhejein aur receipt upload karein. Hamari team approve kare to order confirm ho jata hai.\n**Card** - un USD checkouts par jahan card payment on ho.\n**Cash on delivery** - physical orders par jahan available ho.\nShuru karne ke liye [apna cart](/cart) kholein.',
  },
  'buyer-track': {
    q: 'Main apna order kaise track karoon aur order ke baad kya hota hai?',
    a: 'Order ke baad: payment confirm hoti hai (card par foran, bank transfer par receipt approve hone ke baad), seller order tayyar karta hai, tracking ke saath ship hota hai, phir deliver ho jata hai.\nDigital items payment confirm hote hi khul jate hain.\nHar marhala [Account > Orders](/account/orders) mein dekhein. Status badalne par hum aapko ittila bhi dete hain.',
  },
  'buyer-refund': {
    q: 'Kya mujhe refund ya return mil sakta hai?',
    a: '**Digital items** ka refund sirf tab mumkin hai jab aapne unhein download na kiya ho.\n**Physical items** delivery ke baad return ya refund ho sakte hain.\n[Account > Orders](/account/orders) mein order khol kar item ke liye **Request refund** chunein. Har seller ki return policy product page par nazar aati hai aur hamari team har darkhwast ka jaiza leti hai.',
  },
  'buyer-premium': {
    q: 'Edudeen Premium kya hai?',
    a: '**Edudeen Premium** ek membership hai jis mein ziyada bachat milti hai: sellers ki taraf se member qeematein aur ahal items par Edudeen ki taraf se riayat, sales tak pehle rasai, zaati coupon aur tarjihi support.\nPlans dekhne aur shamil hone ke liye [Premium page](/premium) kholein.',
  },
  'seller-start': {
    q: 'Main selling kaise shuru karoon aur apna store kaise banaoon?',
    a: '[Become a seller](/become-a-seller) kholein, **monthly ya yearly plan** chunein (free trial plan bhi ho sakta hai), store ki tafseelat bharein aur plan ka marhala mukammal karein.\nPhir hamari team aapke store ka jaiza le kar approve karti hai. Aapko ittila milegi aur approval ke baad aap products list kar sakte hain.',
  },
  'seller-add-product': {
    q: 'Main product kaise add karoon?',
    a: 'Apna dashboard kholein aur **Products > Add product** par jayen ([Products](/seller/products)). Qism (physical, digital, educational ya course), category aur sub-category chunein, phir title, images ya files, tafseel aur qeemat add karein.\nPremium members ko riayat dene ke liye form mein **Premium discount** on karein. Listing live hone se pehle Edudeen us ka jaiza le sakta hai.',
  },
  'seller-payout': {
    q: 'Mujhe payment kaise aur kab milegi?',
    a: 'Buyers Edudeen ko payment karte hain, aapko nahi. Order paid hone par aapki kamai (sale price minus platform fee) aapke wallet mein jama ho jati hai - pehle mukhtasar clearing muddat ke liye **pending** aur phir **available**.\n[Finance](/seller/finance) se payout request dein; Edudeen team approve kar ke aapke saved payout account mein raqam bhejti hai. Pehle wahin apna payout method add ya update karein.',
  },
  'seller-fees': {
    q: 'Platform fees kitni hain?',
    a: 'Platform fee Edudeen product ki qism (digital, educational aur course versus physical) ke mutabiq percentage ya per item muqarrar raqam ki surat mein tay karta hai. Yeh sirf item ki qeemat par lagti hai, shipping par kabhi nahi.\nPremium members ko sales par un ka apna Premium fee rate lagta hai. Product form mein **Your earnings** calculator batata hai ke aapko bilkul kitni raqam milegi.',
  },
  'seller-sale': {
    q: 'Main sale ya Premium discount kaise chalaoon?',
    a: '[Marketing](/seller/marketing) kholein: Edudeen ki jari **campaigns aur flash sales** mein shamil hon (aap chun sakte hain kaun si products shamil hon) aur apne discounts banayen. Premium members ke liye product par **Premium discount** on karein aur percentage set karein.\nNormal sale price Premium discount se kam az kam 5 percentage points kam rehni chahiye - aisa na ho to form bata deta hai. Kuch tools aapke plan par munhasir hain.',
  },
};
for (const qa of [...DEFAULT_BUYER_QUESTIONS, ...DEFAULT_SELLER_QUESTIONS]) {
  const ru = ROMAN_URDU[qa.id];
  if (ru) { qa.qRu = ru.q; qa.aRu = ru.a; }
}
