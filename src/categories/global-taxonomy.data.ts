/* eslint-disable prettier/prettier */
/**
 * Edudeen's default category tree for a GLOBAL Muslim education marketplace. Used by
 *   src/scripts/seed-education-categories.ts   (adds what is missing; never edits or deletes)
 *   src/scripts/migrate-global-categories.ts   (moves / renames the few older nodes into this shape)
 *
 * Rules this file follows (checked by global-taxonomy.data.spec.ts):
 * - Islamic groups come first. Audience, curriculum, age and language are product FILTERS, not categories.
 * - At most 3 levels (main > sub > sub-sub), matching MAX_CREATE_DEPTH.
 * - Names are unique among siblings. Existing production names are kept exactly so nothing is duplicated;
 *   `formerNames` lists a name the node used to have (the migration renames it, the slug never changes).
 *
 * Self-contained (no imports): the scripts load it with `node --experimental-strip-types`.
 */
export interface TaxonomyNode {
  name: string;
  description?: string;
  formerNames?: string[];
  icon?: string;
  color?: string;
  nameTranslations?: Record<string, string>;
  allowedProductTypes?: ('physical' | 'digital' | 'course')[];
  requiresListingReview?: boolean;
  subs?: TaxonomyNode[];
}

const leaves = (...names: string[]): TaxonomyNode[] => names.map((name) => ({ name }));

export const GLOBAL_TAXONOMY: TaxonomyNode[] = [
  // ── Islamic groups (top of the list) ────────────────────────────────────
  {
    name: 'Quran & Tajweed', icon: 'book-quran', color: '#1E7F5C', requiresListingReview: true,
    nameTranslations: { ar: 'القرآن والتجويد', ur: 'قرآن و تجوید', ms: 'Al-Quran & Tajwid', tr: "Kur'an ve Tecvid", fr: 'Coran et Tajwid' },
    description: 'Noorani Qaida, Quran reading, Tajweed, Hifz and translation resources.',
    subs: leaves('Noorani Qaida', 'Quran Reading (Nazra)', 'Tajweed Rules', 'Hifz & Revision', 'Quran Translation & Tafseer', 'Dua & Azkar', 'Quranic Arabic'),
  },
  {
    name: 'Islamic Studies', icon: 'mosque', color: '#2E6E4E', requiresListingReview: true,
    nameTranslations: { ar: 'الدراسات الإسلامية', ur: 'اسلامیات', ms: 'Pengajian Islam', tr: 'İslami İlimler', fr: 'Études islamiques' },
    description: 'Aqeedah, Fiqh, Seerah, Hadith and character building for children and students.',
    subs: leaves('Aqeedah (Beliefs)', 'Fiqh & Salah', 'Seerah of the Prophet ﷺ', 'Hadith', 'Islamic History', 'Akhlaq & Adab', 'Stories of the Prophets', 'Islamic Studies Worksheets', 'Islamic Accessories (Prayer Mats, Rehal, Tasbeeh)'),
  },
  {
    name: 'Arabic Language', icon: 'language-arabic', color: '#8A5A2B',
    nameTranslations: { ar: 'اللغة العربية', ur: 'عربی زبان', ms: 'Bahasa Arab', tr: 'Arapça', fr: 'Langue arabe' },
    description: 'Arabic alphabet, reading, grammar and vocabulary for all ages.',
    subs: leaves('Arabic Alphabet & Reading', 'Arabic Grammar (Nahw & Sarf)', 'Arabic Vocabulary', 'Spoken Arabic', 'Arabic for Kids'),
  },
  {
    name: 'Islamic Lifestyle & Family', icon: 'family', color: '#B5651D', requiresListingReview: true,
    nameTranslations: { ar: 'الحياة الإسلامية والأسرة', ur: 'اسلامی طرزِ زندگی و خاندان', ms: 'Gaya Hidup Islam & Keluarga' },
    description: 'Ramadan and Eid, Hajj and Umrah, daily Sunnah and Muslim parenting resources for the whole family.',
    subs: leaves('Ramadan & Eid', 'Hajj & Umrah for Kids', 'Daily Duas & Sunnah', 'Muslim Parenting', 'Modest Wear for Kids', 'Islamic Home & Gifts'),
  },

  // ── Languages and core subjects ────────────────────────────────────────
  {
    name: 'Languages', icon: 'translate', color: '#3A6EA5',
    nameTranslations: { ar: 'اللغات', ur: 'زبانیں', ms: 'Bahasa', tr: 'Diller', fr: 'Langues' },
    description: 'Learn and teach any language: Urdu, English, French, Malay, Turkish and more.',
    subs: [
      // Older databases have these two as MAIN categories; the migration moves them here with their products.
      { name: 'Urdu Language', description: 'Urdu qaida, reading, grammar, writing and literature.',
        subs: leaves('Urdu Qaida & Alphabet', 'Reading & Comprehension', 'Urdu Grammar (Qawaid)', 'Writing & Handwriting', 'Stories & Poetry', 'Urdu Worksheets') },
      { name: 'English Language', description: 'Phonics, grammar, vocabulary, writing and spoken English.',
        subs: leaves('Phonics & Early Reading', 'English Grammar', 'Vocabulary & Spelling', 'Writing & Composition', 'Reading Comprehension', 'Spoken English & IELTS') },
      ...leaves('French', 'Malay & Indonesian', 'Turkish', 'Bengali', 'Persian (Farsi)', 'Other Languages'),
    ],
  },
  {
    name: 'Mathematics', icon: 'calculator', color: '#5B4B8A',
    description: 'From counting to algebra and geometry, with practice and word problems.',
    subs: leaves('Early Numeracy', 'Arithmetic', 'Algebra', 'Geometry', 'Word Problems', 'Mental Math'),
  },
  {
    name: 'Science', icon: 'flask', color: '#2B8A9A',
    description: 'General science, physics, chemistry and biology, with experiments and worksheets.',
    subs: leaves('General Science', 'Physics', 'Chemistry', 'Biology', 'Science Experiments & Kits', 'Muslim Scientists & Inventions'),
  },
  {
    name: 'Social Studies & Geography', formerNames: ['Social Studies & Pakistan Studies'], icon: 'globe', color: '#6B8E23',
    description: 'History, geography, civics and world cultures, including country studies.',
    subs: leaves('Pakistan Studies', 'Geography & Maps', 'History', 'Civics & Citizenship', 'World Cultures', 'Islamic Civilisation'),
  },
  {
    name: 'Early Learning', icon: 'blocks', color: '#E07A5F',
    description: 'Pre-school and kindergarten: alphabets, numbers, colouring and play-based learning.',
    subs: leaves('Alphabets & Numbers', 'Colouring & Activity Books', 'Montessori & Play-based', 'Shapes, Colours & Patterns', 'Fine Motor & Pre-writing', 'Rhymes & Story Time'),
  },
  {
    name: 'Computer & Digital Skills', icon: 'laptop', color: '#264653',
    description: 'Computer basics, coding, office tools, design and AI for learners.',
    subs: leaves('Computer Basics', 'Coding for Kids', 'Typing & MS Office', 'Graphic Design', 'AI & Digital Literacy', 'Online Safety for Kids'),
  },
  {
    name: 'Exam Prep & Past Papers', icon: 'clipboard-check', color: '#9C2F2F',
    description: 'Board exams, entry tests and international qualifications, grouped by region.',
    subs: [
      { name: 'Pakistan Boards & Tests', subs: leaves('Matric / SSC', 'Intermediate / FSc / FA', 'Entry Tests (MDCAT, ECAT, NTS)', 'Scholarship Tests') },
      { name: 'Cambridge & IB', subs: leaves('O Level & A Level', 'IGCSE', 'IB Diploma') },
      { name: 'UK Exams', subs: leaves('GCSE', 'A Level (UK)', '11+ Entrance') },
      { name: 'US & Canada Exams', subs: leaves('SAT', 'ACT', 'State Tests') },
      { name: 'Gulf & Middle East Exams', subs: leaves('EmSAT', 'Qudurat & Tahsili', 'Thanaweya Amma') },
      { name: 'South & South-East Asia Exams', subs: leaves('CBSE / ICSE', 'SPM (Malaysia)', 'SSC / HSC (Bangladesh)') },
      { name: 'Islamic Qualifications', subs: leaves('Wifaq ul Madaris', 'Hifz Certification', 'Ijazah Preparation') },
      { name: 'Past Papers & Model Papers' },
    ],
  },

  // ── For teachers, families and schools ─────────────────────────────────
  {
    name: 'Teacher Resources', icon: 'chalkboard', color: '#1D3557',
    description: 'Lesson plans, printables, assessments and classroom materials for teachers.',
    subs: leaves('Lesson Plans', 'Worksheets & Printables', 'Tests & Assessments', 'Charts & Classroom Decor', 'Classroom Management', 'Rubrics & Report Cards'),
  },
  {
    name: 'Textbooks & Books', icon: 'books', color: '#7F5539',
    description: 'Textbooks, reference books, story books and Islamic books.',
    subs: leaves('Textbooks', 'Reference & Guide Books', "Children's Story Books", 'Islamic Books', 'Dictionaries & Encyclopedias'),
  },
  {
    name: 'Stationery & School Supplies', icon: 'pencil', color: '#F4A261', allowedProductTypes: ['physical'],
    description: 'Everything for the school bag and the study desk.',
    subs: leaves('Notebooks & Copies', 'Pens, Pencils & Markers', 'Art & Craft Supplies', 'Geometry & Math Tools', 'School Bags & Lunch Boxes', 'Desk Organisers'),
  },
  {
    name: 'Educational Toys & Games', icon: 'puzzle', color: '#E76F51', allowedProductTypes: ['physical', 'digital'], requiresListingReview: true,
    description: 'Learning toys, puzzles and games that teach while they entertain.',
    subs: leaves('Learning Toys', 'Puzzles', 'Board & Card Games', 'STEM Kits', 'Islamic Educational Toys'),
  },
  {
    name: 'Handwriting, Art & Creativity', icon: 'palette', color: '#C9184A',
    description: 'Handwriting, calligraphy, drawing and creative projects.',
    subs: leaves('Handwriting Practice', 'Calligraphy (Khattati)', 'Drawing & Colouring', 'Craft & DIY Projects'),
  },
  {
    name: 'Homeschool & Parenting', icon: 'home', color: '#588157',
    description: 'Curriculum plans, study guides and parenting resources for learning at home.',
    subs: leaves('Homeschool Curriculum', 'Study Skills & Planners', 'Parenting Guides', 'Special Education Support'),
  },
  {
    name: 'School & Madrasa Supplies', icon: 'school', color: '#3D405B', allowedProductTypes: ['physical', 'digital'],
    nameTranslations: { ar: 'مستلزمات المدارس والمعاهد', ur: 'اسکول و مدرسہ سپلائیز' },
    description: 'For school owners, madrasas and suppliers: uniforms, furniture, equipment, software and bulk orders.',
    subs: leaves('School Uniforms', 'Classroom Furniture', 'Lab & Science Equipment', 'Sports & PE Equipment', 'Library Supplies', 'School Management Software', 'Madrasa Supplies (Rehal, Mushaf Sets)', 'Bulk & Wholesale Orders'),
  },
  {
    // Kept the live name so the seed reuses the existing category instead of adding a second one.
    name: 'Courses & Live Classes', icon: 'video', color: '#0077B6', allowedProductTypes: ['course', 'digital'], requiresListingReview: true,
    nameTranslations: { ar: 'الدورات والدروس', ur: 'کورسز و ٹیوشن' },
    description: 'Online Quran and Arabic classes, recorded courses, tutoring and teacher training.',
    subs: leaves('Online Quran Classes', 'Arabic Classes', 'School Subject Courses', 'Recorded Courses', 'Teacher Training & CPD', 'Workshops & Events'),
  },
  {
    name: 'Others', icon: 'more', color: '#6C757D',
    description: 'Educational resources that do not fit any other category.',
    subs: leaves('Other Educational Resources', 'Other Books & Materials', 'Other Courses & Services'),
  },
];

/**
 * Older nodes that the migration moves into the shape above (by name, case-insensitive). Products and stores that
 * point at a moved MAIN category are re-pointed so every product's subCategoryId stays inside its categoryId.
 */
export const TAXONOMY_MOVES: { name: string; from: string | null; to: string[] }[] = [
  { name: 'Urdu Language', from: null, to: ['Languages'] },
  { name: 'English Language', from: null, to: ['Languages'] },
  { name: 'Matric / SSC', from: 'Exam Prep & Past Papers', to: ['Exam Prep & Past Papers', 'Pakistan Boards & Tests'] },
  { name: 'Intermediate / FSc / FA', from: 'Exam Prep & Past Papers', to: ['Exam Prep & Past Papers', 'Pakistan Boards & Tests'] },
  { name: 'Entry Tests (MDCAT, ECAT, NTS)', from: 'Exam Prep & Past Papers', to: ['Exam Prep & Past Papers', 'Pakistan Boards & Tests'] },
  { name: 'Scholarship Tests', from: 'Exam Prep & Past Papers', to: ['Exam Prep & Past Papers', 'Pakistan Boards & Tests'] },
  { name: 'O Level & A Level', from: 'Exam Prep & Past Papers', to: ['Exam Prep & Past Papers', 'Cambridge & IB'] },
];

/**
 * Main categories folded into another main category by the migration (see category-merge.plan.ts): subcategories
 * move across (same names are merged), products / stores / pending requests are re-pointed, the old one is soft-deleted.
 */
export const TAXONOMY_MERGES: { from: string; into: string }[] = [
  { from: 'Islamic & Educational Resources', into: 'Islamic Studies' },
];
