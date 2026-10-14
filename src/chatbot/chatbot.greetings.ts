/* eslint-disable prettier/prettier */
import { ChatLang, normalizeText } from './chatbot.lang';

/**
 * Greeting / small-talk table for the chat widget. Maintainable on purpose: to support a new greeting add a phrase to
 * the matching row of PHRASES; to support a new language add its word to HELLO / THANKS / BYE.
 * Phrases are matched at the START of the normalised message (whole words); whatever follows is returned as `rest`.
 */
export type GreetingKind = 'salam' | 'hello' | 'thanks' | 'bye' | 'howareyou' | 'identity' | 'help';

interface PhraseRow { kind: GreetingKind; lang: ChatLang; phrases: string[] }

const PHRASES: PhraseRow[] = [
  // --- Islamic greetings (Roman, Urdu script, Arabic script, Bengali script) are handled by SALAM_* below; "salam" alone too.
  { kind: 'salam', lang: 'ur', phrases: ['السلام علیکم', 'سلام علیکم', 'سلام', 'وعلیکم السلام', 'اسلام علیکم', 'السلام علیکم ورحمۃ اللہ وبرکاتہ'] },
  { kind: 'salam', lang: 'ar', phrases: ['السلام عليكم', 'سلام عليكم', 'وعليكم السلام', 'السلام عليكم ورحمة الله وبركاته'] },
  { kind: 'salam', lang: 'bn', phrases: ['আসসালামু আলাইকুম', 'সালাম'] },
  { kind: 'hello', lang: 'en', phrases: ['hello', 'hi', 'hey', 'hiya', 'heya', 'howdy', 'greetings', 'good morning', 'good afternoon', 'good evening', 'good day', 'good night', 'gm', 'sup'] },
  { kind: 'hello', lang: 'ur-latn', phrases: ['adaab', 'aadab', 'adab', 'subah bakhair', 'subha bakhair', 'shab bakhair', 'khush amdeed', 'khushamdeed'] },
  { kind: 'hello', lang: 'ur', phrases: ['ہیلو', 'ہائے', 'ہائی', 'آداب', 'صبح بخیر', 'شب بخیر', 'خوش آمدید'] },
  { kind: 'hello', lang: 'ar', phrases: ['مرحبا', 'مرحبا بك', 'اهلا', 'اهلا وسهلا', 'صباح الخير', 'مساء الخير', 'هلا'] },
  { kind: 'hello', lang: 'hi', phrases: ['नमस्ते', 'नमस्कार', 'हेलो', 'हैलो', 'सुप्रभात'] },
  { kind: 'hello', lang: 'fr', phrases: ['bonjour', 'salut', 'bonsoir', 'coucou'] },
  { kind: 'hello', lang: 'es', phrases: ['hola', 'buenos dias', 'buenas tardes', 'buenas noches', 'buenas'] },
  { kind: 'hello', lang: 'de', phrases: ['hallo', 'guten tag', 'guten morgen', 'guten abend', 'moin', 'servus', 'grüß gott'] },
  { kind: 'hello', lang: 'tr', phrases: ['merhaba', 'selam', 'gunaydin', 'iyi gunler', 'iyi aksamlar'] },
  { kind: 'hello', lang: 'bn', phrases: ['নমস্কার', 'হ্যালো', 'হাই', 'শুভ সকাল'] },
  { kind: 'hello', lang: 'zh', phrases: ['你好', '您好', '哈喽', '嗨', '早上好', '晚上好', '下午好'] },
  { kind: 'hello', lang: 'ms', phrases: ['selamat pagi', 'selamat siang', 'selamat sore', 'selamat petang', 'selamat malam', 'selamat tengah hari', 'halo', 'hai'] },
  { kind: 'hello', lang: 'pt', phrases: ['ola', 'bom dia', 'boa tarde', 'boa noite', 'oi'] },
  { kind: 'hello', lang: 'it', phrases: ['ciao', 'buongiorno', 'buonasera', 'salve'] },
  { kind: 'hello', lang: 'ru', phrases: ['привет', 'здравствуйте', 'добрый день', 'доброе утро'] },
  { kind: 'hello', lang: 'ja', phrases: ['こんにちは', 'こんばんは', 'おはよう', 'おはようございます'] },
  { kind: 'hello', lang: 'ko', phrases: ['안녕하세요', '안녕'] },

  { kind: 'howareyou', lang: 'en', phrases: ['how are you', 'how r u', 'how are u', 'hows it going', 'how is it going', 'how do you do', 'whats up', 'how are you doing'] },
  { kind: 'howareyou', lang: 'ur-latn', phrases: ['kaise ho', 'kese ho', 'kaisay ho', 'kaise hain', 'kese hain', 'kaisay hain', 'aap kaise hain', 'ap kaise hain', 'aap kese hain', 'kya haal hai', 'kia haal hai', 'haal chaal', 'kya haal', 'kia haal', 'theek ho', 'aap theek hain'] },
  { kind: 'howareyou', lang: 'ur', phrases: ['کیسے ہیں', 'آپ کیسے ہیں', 'کیسے ہو', 'کیا حال ہے', 'حال چال', 'کیا حال'] },
  { kind: 'howareyou', lang: 'ar', phrases: ['كيف حالك', 'كيف الحال', 'كيفك', 'شلونك'] },
  { kind: 'howareyou', lang: 'fr', phrases: ['comment ca va', 'ca va', 'comment allez vous', 'comment vas tu'] },
  { kind: 'howareyou', lang: 'es', phrases: ['como estas', 'como esta', 'que tal', 'como andas'] },
  { kind: 'howareyou', lang: 'de', phrases: ['wie gehts', 'wie geht es dir', 'wie geht es ihnen', 'wie geht s'] },
  { kind: 'howareyou', lang: 'tr', phrases: ['nasilsin', 'nasilsiniz', 'naber', 'ne haber'] },
  { kind: 'howareyou', lang: 'ms', phrases: ['apa khabar', 'apa kabar', 'bagaimana kabar'] },
  { kind: 'howareyou', lang: 'hi', phrases: ['आप कैसे हैं', 'कैसे हो', 'क्या हाल है'] },
  { kind: 'howareyou', lang: 'zh', phrases: ['你好吗', '你怎么样', '最近怎么样'] },

  { kind: 'thanks', lang: 'en', phrases: ['thanks', 'thank you', 'thank u', 'thx', 'tysm', 'ty', 'many thanks', 'thanks a lot', 'thank you so much', 'much appreciated', 'appreciate it'] },
  { kind: 'thanks', lang: 'ur-latn', phrases: ['shukriya', 'shukria', 'shukriah', 'bohat shukriya', 'bahut shukriya', 'meherbani', 'mehrbani', 'jazakallah', 'jazak allah', 'jazakallah khair', 'jazakallahu khairan', 'jazak allah khair', 'jazakumullah'] },
  { kind: 'thanks', lang: 'ur', phrases: ['شکریہ', 'بہت شکریہ', 'مہربانی', 'جزاک اللہ', 'جزاک اللہ خیر', 'جزاک اللہ خیرا'] },
  { kind: 'thanks', lang: 'ar', phrases: ['شكرا', 'شكرا لك', 'شكرا جزيلا', 'جزاك الله خيرا', 'جزاك الله'] },
  { kind: 'thanks', lang: 'fr', phrases: ['merci', 'merci beaucoup'] },
  { kind: 'thanks', lang: 'es', phrases: ['gracias', 'muchas gracias'] },
  { kind: 'thanks', lang: 'de', phrases: ['danke', 'vielen dank', 'danke schon'] },
  { kind: 'thanks', lang: 'tr', phrases: ['tesekkurler', 'tesekkur ederim', 'sagol', 'sag ol'] },
  { kind: 'thanks', lang: 'ms', phrases: ['terima kasih', 'makasih', 'terimakasih'] },
  { kind: 'thanks', lang: 'hi', phrases: ['धन्यवाद', 'शुक्रिया', 'बहुत धन्यवाद'] },
  { kind: 'thanks', lang: 'bn', phrases: ['ধন্যবাদ'] },
  { kind: 'thanks', lang: 'zh', phrases: ['谢谢', '谢谢你', '多谢', '感谢'] },
  { kind: 'thanks', lang: 'pt', phrases: ['obrigado', 'obrigada', 'valeu'] },
  { kind: 'thanks', lang: 'it', phrases: ['grazie', 'grazie mille'] },
  { kind: 'thanks', lang: 'ru', phrases: ['спасибо', 'благодарю'] },
  { kind: 'thanks', lang: 'ja', phrases: ['ありがとう', 'ありがとうございます'] },

  { kind: 'bye', lang: 'en', phrases: ['bye', 'goodbye', 'good bye', 'bye bye', 'see you', 'see ya', 'take care', 'cya', 'talk later', 'ttyl'] },
  { kind: 'bye', lang: 'ur-latn', phrases: ['allah hafiz', 'allahhafiz', 'khuda hafiz', 'khudahafiz', 'khuda hafez', 'allah hafez', 'fi amanillah', 'phir milte hain'] },
  { kind: 'bye', lang: 'ur', phrases: ['خدا حافظ', 'اللہ حافظ', 'الوداع', 'پھر ملتے ہیں'] },
  { kind: 'bye', lang: 'ar', phrases: ['مع السلامه', 'الى اللقاء', 'وداعا'] },
  { kind: 'bye', lang: 'fr', phrases: ['au revoir', 'a bientot', 'adieu'] },
  { kind: 'bye', lang: 'es', phrases: ['adios', 'hasta luego', 'hasta pronto', 'chao'] },
  { kind: 'bye', lang: 'de', phrases: ['tschuss', 'tschuss', 'auf wiedersehen', 'bis bald'] },
  { kind: 'bye', lang: 'tr', phrases: ['hoscakal', 'hosca kal', 'gorusuruz', 'gule gule'] },
  { kind: 'bye', lang: 'ms', phrases: ['selamat tinggal', 'jumpa lagi', 'sampai jumpa'] },
  { kind: 'bye', lang: 'hi', phrases: ['अलविदा', 'फिर मिलेंगे'] },
  { kind: 'bye', lang: 'zh', phrases: ['再见', '拜拜'] },
  { kind: 'bye', lang: 'pt', phrases: ['tchau', 'adeus'] },
  { kind: 'bye', lang: 'it', phrases: ['arrivederci', 'addio'] },
  { kind: 'bye', lang: 'ru', phrases: ['до свидания', 'пока'] },
  { kind: 'bye', lang: 'ja', phrases: ['さようなら', 'じゃあね'] },

  { kind: 'identity', lang: 'en', phrases: ['who are you', 'what are you', 'are you a bot', 'are you human', 'are you real', 'your name', 'what is your name', 'whats your name'] },
  { kind: 'identity', lang: 'ur-latn', phrases: ['tum kaun ho', 'aap kaun hain', 'ap kaun hain', 'aap kon hain', 'tum kon ho', 'aap ka naam kya hai', 'apka naam kya hai', 'tumhara naam kya hai'] },
  { kind: 'identity', lang: 'ur', phrases: ['آپ کون ہیں', 'تم کون ہو', 'آپ کا نام کیا ہے'] },
  { kind: 'help', lang: 'en', phrases: ['help', 'help me', 'i need help', 'need help', 'can you help', 'can you help me', 'support', 'menu', 'options', 'start'] },
  { kind: 'help', lang: 'ur-latn', phrases: ['madad', 'madad chahiye', 'mujhe madad chahiye', 'meri madad karo', 'meri madad karein', 'help karo', 'help chahiye'] },
  { kind: 'help', lang: 'ur', phrases: ['مدد', 'مدد چاہیے', 'مجھے مدد چاہیے', 'میری مدد کریں'] },
];

/** Roman-script salam forms: matched on the compact (space-free) letters of the first words. */
const SALAM_CORE = '(?:a?s{1,2}a?l{1,2}a{1,2}m{1,2}(?:u|o|w|wa)?(?:a?l{1,2}a?[iy]?k(?:u|o|a)?m{1,2})?|walaikum(?:u|o)?a?s{1,2}a?l{1,2}a{1,2}m{1,2}(?:u|o)?|aoa|slm)';
const SALAM_TAIL = '(?:w?a?rahmatu?l{1,2}ahi?)?(?:w?a?barakatu?h?)?(?:wrwb)?';
const SALAM_RX = new RegExp(`^${SALAM_CORE}${SALAM_TAIL}$`);

/** Words that may follow a greeting without changing its meaning ("salam bhai", "hello there"). */
const FILLER = new Set(['bhai', 'bhaijan', 'bhi', 'sir', 'madam', 'maam', 'team', 'edudeen', 'everyone', 'all', 'sab', 'sabko', 'there', 'brother', 'sister', 'admin', 'support', 'dost', 'ji', 'jee', 'and', 'aur', 'sahab', 'sahib', 'apa', 'baji', 'again', 'so', 'much', 'very', 'bohat', 'bahut', 'a', 'lot', 'you', 'u', 'to', 'sabhi', 'friend', 'friends', 'dear', 'allah', 'khair', 'khairan']);

interface Compiled { kind: GreetingKind; lang: ChatLang; norm: string }
const COMPILED: Compiled[] = PHRASES
  .flatMap(r => r.phrases.map(p => ({ kind: r.kind, lang: r.lang, norm: normalizeText(p) })))
  .filter(c => c.norm)
  .sort((a, b) => b.norm.length - a.norm.length);

export interface GreetingMatch { kinds: GreetingKind[]; lang: ChatLang; rest: string }

/** Pure. Consumes up to 3 greeting phrases from the start of the message; `rest` is what is left (empty = a pure greeting). */
export function detectGreeting(text: string): GreetingMatch | null {
  let norm = normalizeText(text);
  if (!norm) return null;
  const kinds: GreetingKind[] = [];
  let lang: ChatLang | null = null;
  for (let i = 0; i < 3 && norm; i++) {
    let consumed = false;
    // 1) Roman salam (compact letters of the first 1-6 words)
    const words = norm.split(' ');
    for (let n = Math.min(words.length, 6); n >= 1 && !consumed; n--) {
      const compact = words.slice(0, n).join('');
      if (/^[a-z]+$/.test(compact) && SALAM_RX.test(compact)) {
        kinds.push('salam'); lang = lang ?? 'ur-latn'; norm = words.slice(n).join(' '); consumed = true;
      }
    }
    // 2) phrase table (longest first)
    if (!consumed) {
      for (const c of COMPILED) {
        if (norm === c.norm || norm.startsWith(c.norm + ' ') || (/^[　-鿿぀-ヿ]/.test(c.norm) && norm.startsWith(c.norm))) {
          kinds.push(c.kind); lang = lang ?? c.lang;
          norm = norm.slice(c.norm.length).trim(); consumed = true; break;
        }
      }
    }
    // 3) regex-y English/typo forms: hii, heyy, hellooo
    if (!consumed) {
      const m = /^(h+i+|h+e+y+|h+e+l+o+|h+a+i+)(?=\s|$)/.exec(norm);
      if (m) { kinds.push('hello'); lang = lang ?? 'en'; norm = norm.slice(m[0].length).trim(); consumed = true; }
    }
    if (!consumed) break;
    // Drop filler words between/after greetings.
    norm = norm.split(' ').filter((w, idx, arr) => !(FILLER.has(w) && arr.slice(0, idx).every(x => FILLER.has(x)))).join(' ').trim();
  }
  if (!kinds.length) return null;
  // Urdu and Arabic share most salam spellings once normalised; Arabic-only letters (ي ك ة ى) tell them apart.
  if (lang === 'ur' && /[يكةى]/.test(text)) lang = 'ar';
  return { kinds, lang: lang ?? 'en', rest: norm };
}

// ---- Replies ---------------------------------------------------------------------------------------------------

const WELCOME_EN = 'Welcome to Edudeen Help. Tap a question below or type your own.';
const WELCOME_UR = 'ایڈودین ہیلپ میں خوش آمدید۔ نیچے سے کوئی سوال چنیں یا اپنا سوال لکھیں۔';
const WELCOME_RU = 'Edudeen Help mein khush amdeed. Neeche se koi sawal chunein ya apna sawal likhein.';

const HELLO: Partial<Record<ChatLang, string>> = {
  en: 'Hello!', 'ur-latn': 'Assalamualaikum!', ur: 'السلام علیکم!', ar: 'أهلاً وسهلاً!', hi: 'नमस्ते!', fr: 'Bonjour !', es: '¡Hola!', de: 'Hallo!', tr: 'Merhaba!', bn: 'নমস্কার!',
  zh: '你好！', ms: 'Hai, selamat datang!', pt: 'Olá!', it: 'Ciao!', ru: 'Здравствуйте!', ja: 'こんにちは！', ko: '안녕하세요!',
};
const SALAM: Partial<Record<ChatLang, string>> = {
  'ur-latn': 'Wa alaikum assalam wa rahmatullahi wa barakatuh! Welcome to Edudeen.',
  en: 'Wa alaikum assalam wa rahmatullahi wa barakatuh! Welcome to Edudeen.',
  ur: 'وعلیکم السلام ورحمۃ اللہ وبرکاتہ! ایڈودین میں خوش آمدید۔',
  ar: 'وعليكم السلام ورحمة الله وبركاته! أهلاً بك في إيدودين.',
  bn: 'ওয়া আলাইকুম আসসালাম ওয়া রাহমাতুল্লাহি ওয়া বারাকাতুহ! এডুদিনে স্বাগতম।',
};
const THANKS: Partial<Record<ChatLang, string>> = {
  en: 'You are welcome!', 'ur-latn': 'Wa iyyakum! Khushi hui madad kar ke.', ur: 'وایاکم! آپ کی مدد کر کے خوشی ہوئی۔', ar: 'وإياكم! عفواً.', hi: 'आपका स्वागत है!', fr: 'De rien !', es: '¡De nada!', de: 'Gern geschehen!',
  tr: 'Rica ederim!', bn: 'স্বাগতম!', zh: '不客气！', ms: 'Sama-sama!', pt: 'De nada!', it: 'Prego!', ru: 'Пожалуйста!', ja: 'どういたしまして！', ko: '천만에요!',
};
const JAZAK: Partial<Record<ChatLang, string>> = {
  en: 'Wa iyyakum! Jazakumullahu khairan.', 'ur-latn': 'Wa iyyakum! Jazakumullahu khairan.', ur: 'وایاکم! جزاکم اللہ خیراً۔', ar: 'وإياكم! جزاكم الله خيراً.',
};
const BYE: Partial<Record<ChatLang, string>> = {
  en: 'Goodbye! Come back any time you need help.', 'ur-latn': 'Allah hafiz! Jab bhi madad chahiye, wapas aa jayen.', ur: 'اللہ حافظ! جب بھی مدد چاہیے ہو، واپس آ جائیں۔', ar: 'مع السلامة! عُد في أي وقت.', hi: 'अलविदा! जब भी मदद चाहिए, लौट आइए।',
  fr: 'Au revoir ! Revenez quand vous voulez.', es: '¡Adiós! Vuelve cuando necesites ayuda.', de: 'Auf Wiedersehen! Kommen Sie jederzeit wieder.', tr: 'Hoşça kal! İhtiyacın olunca tekrar gel.',
  bn: 'বিদায়! প্রয়োজনে আবার আসবেন।', zh: '再见！需要帮助时随时回来。', ms: 'Selamat tinggal! Kembali bila-bila masa.', pt: 'Tchau! Volte quando precisar.', it: 'Arrivederci!', ru: 'До свидания!', ja: 'さようなら！', ko: '안녕히 가세요!',
};
const HOW: Partial<Record<ChatLang, string>> = {
  en: 'Alhamdulillah, I am doing well, thank you for asking! How can I help you today?',
  'ur-latn': 'Alhamdulillah, main theek hoon, poochne ka shukriya! Aaj main aapki kya madad kar sakta hoon?',
  ur: 'الحمدللہ، میں ٹھیک ہوں، پوچھنے کا شکریہ! آج میں آپ کی کیا مدد کر سکتا ہوں؟',
  ar: 'الحمد لله، أنا بخير، شكراً لسؤالك! كيف أستطيع مساعدتك اليوم؟',
  fr: 'Alhamdulillah, je vais bien, merci ! Comment puis-je vous aider ?', es: '¡Alhamdulillah, estoy bien, gracias! ¿En qué puedo ayudarte?', de: 'Alhamdulillah, mir geht es gut, danke! Wie kann ich helfen?',
  tr: 'Elhamdülillah iyiyim, teşekkürler! Nasıl yardımcı olabilirim?', ms: 'Alhamdulillah, saya sihat, terima kasih! Apa yang boleh saya bantu?', hi: 'अलहम्दुलिल्लाह, मैं ठीक हूँ, धन्यवाद! मैं कैसे मदद कर सकता हूँ?', zh: '我很好，谢谢！有什么可以帮您的吗？', bn: 'আলহামদুলিল্লাহ, আমি ভালো আছি! কীভাবে সাহায্য করতে পারি?',
};
const IDENTITY: Partial<Record<ChatLang, string>> = {
  en: 'I am the Edudeen help assistant. I answer questions about shopping, payments, orders, selling and more on Edudeen.',
  'ur-latn': 'Main Edudeen ka madadgar hoon. Main Edudeen par kharidari, payment, orders aur selling ke sawalat ke jawab deta hoon.',
  ur: 'میں ایڈودین کا مددگار ہوں۔ میں ایڈودین پر خریداری، ادائیگی، آرڈرز اور فروخت سے متعلق سوالات کے جواب دیتا ہوں۔',
};
const HELP: Partial<Record<ChatLang, string>> = {
  en: 'Sure, I can help. Here are some popular questions:', 'ur-latn': 'Zaroor, main madad karta hoon. Yeh kuch aam sawal hain:', ur: 'ضرور، میں مدد کرتا ہوں۔ یہ کچھ عام سوالات ہیں:',
};

export interface GreetingReplyOptions {
  /** The site language / the language the visitor wrote in decides Urdu vs English wording. */
  replyLang: ChatLang;
  welcomeEn?: string;
  welcomeUr?: string;
}

/** Pure: build the reply text for a greeting match. The reply follows the greeting's own language; Roman Urdu keeps Roman Urdu. */
export function greetingReply(m: GreetingMatch, opts: GreetingReplyOptions): string {
  const lang = m.lang;
  const want: ChatLang = lang === 'en' && opts.replyLang === 'ur' ? 'ur' : lang;
  const welcomeUrdu = want === 'ur' || (want === 'ur-latn' && opts.replyLang === 'ur');
  const welcome = want === 'ur-latn' && opts.replyLang !== 'ur' ? WELCOME_RU : welcomeUrdu ? (opts.welcomeUr || WELCOME_UR) : (opts.welcomeEn || WELCOME_EN);
  const pieces: string[] = [];
  const pick = (t: Partial<Record<ChatLang, string>>) => t[want] ?? t.en!;
  const first = m.kinds[0];
  let wantsWelcome = false;
  for (const k of m.kinds) {
    if (k === 'salam') { pieces.push(pick(SALAM)); wantsWelcome = true; }
    else if (k === 'hello') { pieces.push(pick(HELLO)); wantsWelcome = true; }
    else if (k === 'thanks') {
      pieces.push(pick(THANKS));
    }
    else if (k === 'bye') pieces.push(pick(BYE));
    else if (k === 'howareyou') pieces.push(pick(HOW));
    else if (k === 'identity') pieces.push(pick(IDENTITY));
    else if (k === 'help') pieces.push(pick(HELP));
  }
  if (first === 'thanks' && m.kinds.length === 1) pieces.push(want === 'ur' ? 'کیا میں اور کسی چیز میں مدد کر سکتا ہوں؟' : want === 'ur-latn' ? 'Kya main kisi aur cheez mein madad kar sakta hoon?' : 'Is there anything else I can help with?');
  if (wantsWelcome && !m.kinds.includes('howareyou')) pieces.push(welcome);
  return pieces.join(' ');
}

/** Variant of greetingReply that knows the original text (to tell "jazakallah" from plain thanks). */
export function greetingReplyFor(text: string, m: GreetingMatch, opts: GreetingReplyOptions): string {
  const jazak = /jazak|جزاک|جزاك/.test(normalizeText(text));
  if (jazak && m.kinds.includes('thanks')) {
    const lang = m.lang;
    const want: ChatLang = lang === 'en' && opts.replyLang === 'ur' ? 'ur' : lang;
    const base = JAZAK[want] ?? JAZAK.en!;
    return `${base} ${want === 'ur' ? 'کیا میں اور کسی چیز میں مدد کر سکتا ہوں؟' : want === 'ur-latn' ? 'Kya main kisi aur cheez mein madad kar sakta hoon?' : 'Is there anything else I can help with?'}`;
  }
  return greetingReply(m, opts);
}

/** Small-talk kinds that should be followed by the suggested-question chips. */
export const KINDS_WITH_CHIPS: GreetingKind[] = ['salam', 'hello', 'help', 'identity', 'howareyou'];
