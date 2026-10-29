/**
 * Adds Edudeen's default education categories (the list is in this file).
 * ADDITIVE and idempotent: a category that already exists (same name under the same parent, case-insensitive) is
 * left exactly as it is; nothing is edited, renamed, reordered or deleted. DRY-RUN by default.
 *
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-education-categories.ts            # plan only
 *   node --env-file=.env --experimental-strip-types src/scripts/seed-education-categories.ts --apply    # writes
 *
 * (npm run seed:categories / seed:categories:apply). Run it only against the database you mean to change.
 */
import mongoose from 'mongoose';

// Two levels only (the API does not allow deeper nesting). Grade / curriculum / age are separate product filters.
interface SeedCategory { name: string; description: string; subs: string[] }

const EDUCATION_CATEGORIES: SeedCategory[] = [
  { name: 'Quran & Tajweed', description: 'Noorani Qaida, Quran reading, Tajweed, Hifz and translation resources.',
    subs: ['Noorani Qaida', 'Quran Reading (Nazra)', 'Tajweed Rules', 'Hifz & Revision', 'Quran Translation & Tafseer', 'Dua & Azkar', 'Quranic Arabic'] },
  { name: 'Islamic Studies', description: 'Aqeedah, Fiqh, Seerah, Hadith and character building for children and students.',
    subs: ['Aqeedah (Beliefs)', 'Fiqh & Salah', 'Seerah of the Prophet ﷺ', 'Hadith', 'Islamic History', 'Akhlaq & Adab', 'Stories of the Prophets', 'Islamic Studies Worksheets', 'Islamic Accessories (Prayer Mats, Rehal, Tasbeeh)'] },
  { name: 'Arabic Language', description: 'Arabic alphabet, reading, grammar and vocabulary for all ages.',
    subs: ['Arabic Alphabet & Reading', 'Arabic Grammar (Nahw & Sarf)', 'Arabic Vocabulary', 'Spoken Arabic', 'Arabic for Kids'] },
  { name: 'Urdu Language', description: 'Urdu qaida, reading, grammar, writing and literature.',
    subs: ['Urdu Qaida & Alphabet', 'Reading & Comprehension', 'Urdu Grammar (Qawaid)', 'Writing & Handwriting', 'Stories & Poetry', 'Urdu Worksheets'] },
  { name: 'English Language', description: 'Phonics, grammar, vocabulary, writing and spoken English.',
    subs: ['Phonics & Early Reading', 'English Grammar', 'Vocabulary & Spelling', 'Writing & Composition', 'Reading Comprehension', 'Spoken English & IELTS'] },
  { name: 'Mathematics', description: 'From counting to algebra and geometry, with practice and word problems.',
    subs: ['Early Numeracy', 'Arithmetic', 'Algebra', 'Geometry', 'Word Problems', 'Mental Math'] },
  { name: 'Science', description: 'General science, physics, chemistry and biology, with experiments and worksheets.',
    subs: ['General Science', 'Physics', 'Chemistry', 'Biology', 'Science Experiments & Kits'] },
  { name: 'Social Studies & Pakistan Studies', description: 'Pakistan studies, geography, history and civics.',
    subs: ['Pakistan Studies', 'Geography & Maps', 'History', 'Civics & Citizenship', 'World Cultures'] },
  { name: 'Early Learning', description: 'Pre-school and kindergarten: alphabets, numbers, colouring and play-based learning.',
    subs: ['Alphabets & Numbers', 'Colouring & Activity Books', 'Montessori & Play-based', 'Shapes, Colours & Patterns', 'Fine Motor & Pre-writing', 'Rhymes & Story Time'] },
  { name: 'Computer & Digital Skills', description: 'Computer basics, coding, office tools, design and AI for learners.',
    subs: ['Computer Basics', 'Coding for Kids', 'Typing & MS Office', 'Graphic Design', 'AI & Digital Literacy'] },
  { name: 'Exam Prep & Past Papers', description: 'Board exams, entry tests and Cambridge-level preparation.',
    subs: ['Matric / SSC', 'Intermediate / FSc / FA', 'O Level & A Level', 'Entry Tests (MDCAT, ECAT, NTS)', 'Past Papers & Model Papers', 'Scholarship Tests'] },
  { name: 'Teacher Resources', description: 'Lesson plans, printables, assessments and classroom materials for teachers.',
    subs: ['Lesson Plans', 'Worksheets & Printables', 'Tests & Assessments', 'Charts & Classroom Decor', 'Classroom Management', 'Rubrics & Report Cards'] },
  { name: 'Textbooks & Books', description: 'Textbooks, reference books, story books and Islamic books.',
    subs: ['Textbooks', 'Reference & Guide Books', "Children's Story Books", 'Islamic Books', 'Dictionaries & Encyclopedias'] },
  { name: 'Stationery & School Supplies', description: 'Everything for the school bag and the study desk.',
    subs: ['Notebooks & Copies', 'Pens, Pencils & Markers', 'Art & Craft Supplies', 'Geometry & Math Tools', 'School Bags & Lunch Boxes', 'Desk Organisers'] },
  { name: 'Educational Toys & Games', description: 'Learning toys, puzzles and games that teach while they entertain.',
    subs: ['Learning Toys', 'Puzzles', 'Board & Card Games', 'STEM Kits', 'Islamic Educational Toys'] },
  { name: 'Handwriting, Art & Creativity', description: 'Handwriting, calligraphy, drawing and creative projects.',
    subs: ['Handwriting Practice', 'Calligraphy (Khattati)', 'Drawing & Colouring', 'Craft & DIY Projects'] },
  { name: 'Homeschool & Parenting', description: 'Curriculum plans, study guides and parenting resources for learning at home.',
    subs: ['Homeschool Curriculum', 'Study Skills & Planners', 'Parenting Guides', 'Special Education Support'] },
  { name: 'Others', description: 'Educational resources that do not fit any other category.',
    subs: ['Other Educational Resources', 'Other Books & Materials', 'Other Courses & Services'] },
];

const slugify = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-+|-+$/g, '') || 'category';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const col = db.collection('categories');

  const usedSlugs = new Set<string>((await col.find({}, { projection: { slug: 1 } }).toArray()).map((c: any) => c.slug).filter(Boolean));
  const uniqueSlug = (name: string, parentSlug?: string) => {
    const base = slugify(name);
    let slug = base;
    if (usedSlugs.has(slug) && parentSlug) slug = `${parentSlug}-${base}`;
    for (let i = 2; usedSlugs.has(slug); i++) slug = `${base}-${i}`;
    usedSlugs.add(slug);
    return slug;
  };
  const find = (name: string, parentId: string | null) =>
    col.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, parentId, isDelete: { $ne: true } });

  let createdMain = 0, createdSub = 0, existed = 0;
  const now = new Date();
  const maxSort = (await col.find({ parentId: null }).sort({ sortOrder: -1 }).limit(1).toArray())[0]?.sortOrder ?? -1;
  let sort = Number(maxSort) + 1;

  for (const main of EDUCATION_CATEGORIES) {
    let parent: any = await find(main.name, null);
    if (parent) existed++;
    else {
      createdMain++;
      const doc = {
        name: main.name, slug: uniqueSlug(main.name), parentId: null, image: null, description: main.description,
        sortOrder: sort++, status: 'active', isDelete: false, createdBy: null, createdByRole: 'admin', seo: {},
        createdAt: now, updatedAt: now,
      };
      console.log(`+ ${main.name}`);
      if (apply) { const r = await col.insertOne(doc); parent = { _id: r.insertedId, slug: doc.slug }; }
      else parent = { _id: `dry:${main.name}`, slug: doc.slug };
    }
    const parentId = String(parent._id);
    let subSort = 0;
    for (const sub of main.subs) {
      const found = String(parentId).startsWith('dry:') ? null : await find(sub, parentId);
      if (found) { existed++; subSort++; continue; }
      createdSub++;
      console.log(`    + ${sub}`);
      if (apply) {
        await col.insertOne({
          name: sub, slug: uniqueSlug(sub, parent.slug), parentId, image: null, description: null,
          sortOrder: subSort, status: 'active', isDelete: false, createdBy: null, createdByRole: 'admin', seo: {},
          createdAt: now, updatedAt: now,
        });
      }
      subSort++;
    }
  }

  console.log(`\n${apply ? 'DONE' : 'DRY RUN - nothing written'}: ${createdMain} main + ${createdSub} sub categories ${apply ? 'created' : 'would be created'}; ${existed} already existed (left untouched).`);
  if (!apply) console.log('Re-run with --apply to write them.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
