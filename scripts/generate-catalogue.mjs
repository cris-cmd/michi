#!/usr/bin/env node
// Deterministic synthetic activity catalogue for Michi.
// Seeded PRNG → same output every run (verified by harness/deterministic.ts).
// 900+ activities: 12 curated items with stable ids plus template×area
// generation that creates meaningful trade-offs.
// every activity carries at least one reason it could be wrong for someone.
// All records are provenance {type:"synthetic"}: intentionally demo inventory.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 20260808;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;

// Tokyo neighbourhoods: [name, travelMinutes from a central hotel, lat, lng]
const AREAS = [
  ["Yanaka", 18, 35.7276, 139.7663],
  ["Asakusa", 22, 35.7118, 139.7967],
  ["Kappabashi", 20, 35.7139, 139.7886],
  ["Kuramae", 19, 35.7038, 139.7906],
  ["Nihonbashi", 8, 35.6839, 139.7744],
  ["Ginza", 6, 35.6717, 139.765],
  ["Tsukiji", 12, 35.6655, 139.7708],
  ["Shibuya", 15, 35.658, 139.7016],
  ["Daikanyama", 18, 35.6485, 139.7031],
  ["Shimokitazawa", 28, 35.6613, 139.6683],
  ["Koenji", 30, 35.7052, 139.6497],
  ["Kagurazaka", 12, 35.7027, 139.7401],
  ["Yanesen", 19, 35.7256, 139.7641],
  ["Kiyosumi", 14, 35.6805, 139.7995],
  ["Ryogoku", 16, 35.6937, 139.7936],
  ["Ueno", 15, 35.7141, 139.7774],
  ["Akihabara", 10, 35.6984, 139.7731],
  ["Omotesando", 14, 35.6653, 139.712],
  ["Nakameguro", 20, 35.6443, 139.6983],
  ["Sumida", 21, 35.7101, 139.8014],
  ["Fukagawa", 15, 35.6717, 139.7966],
  ["Ochanomizu", 9, 35.6993, 139.7654],
  ["Shinjuku", 14, 35.6938, 139.7034],
  ["Harajuku", 16, 35.6702, 139.7027],
  ["Roppongi", 12, 35.6627, 139.7307],
  ["Kichijoji", 32, 35.7031, 139.5797],
  ["Setagaya", 26, 35.6464, 139.6533],
  ["Meguro", 18, 35.6339, 139.7158],
  ["Odaiba", 28, 35.6251, 139.7756],
  ["Toyosu", 22, 35.6543, 139.7966],
  ["Marunouchi", 5, 35.6812, 139.7649],
  ["Kamakura", 65, 35.3192, 139.5467],
  ["Yokohama", 40, 35.4437, 139.638],
  ["Kawagoe", 55, 35.9251, 139.4858],
];

const OPERATOR_PREFIX = ["Studio", "Atelier", "House", "Workshop", "Kobo", "Salon", "Bureau", "Guild"];
const OPERATOR_NAME = ["Kaede", "Tsubaki", "Hinoki", "Suzume", "Aoi", "Momiji", "Yuzu", "Kikyo", "Sakura", "Fuji", "Tsuru", "Kame", "Ume", "Ayame", "Botan", "Kiri", "Nadeshiko", "Ran", "Take", "Matsu"];

// Slot-time sets; the per-DATE openness comes from availability patterns
// (src/data/availability.ts expands them deterministically per date).
const TIME_SETS = [
  ["10:00", "14:00", "16:00"],
  ["09:30", "13:00", "15:30"],
  ["11:00", "15:00"],
  ["14:00", "16:30"],
  ["10:30", "13:30", "16:00"],
  ["15:00"], // one fixed start
  ["10:00", "11:30"],
];
const EVENING_TIMES = [["19:00", "20:00"], ["19:30"], ["18:30", "20:30"]];
const MORNING_TIMES = [["09:00", "10:00"], ["08:30"], ["09:30", "11:00"]];
const PATTERN_KINDS = ["daily", "daily", "daily", "closed_monday", "closed_monday", "weekdays", "weekends", "sparse", "sparse"];
const SOLD_OUT_RATES = [0, 0, 0, 0.08, 0.15, 0.3];

function makeAvailability(t) {
  const evening = t.cats.includes("evening");
  const morning = t.key === "sumo" || t.key === "fishmarket";
  const times = evening ? pick(EVENING_TIMES) : morning ? pick(MORNING_TIMES) : pick(TIME_SETS);
  return { kind: pick(PATTERN_KINDS), times, soldOutRate: pick(SOLD_OUT_RATES) };
}

// Each template: [key, namePatterns, categories, indoor, rain, heat, infant,
// stroller, minAge, wheelchair, stairs, intensity, quiet, crowd, culture,
// tourist, langs, foodInvolved, veg, alcohol, durMin, durMax, priceLo,
// priceHi, frictions, descBits]
// Values may be ranges [lo,hi] varied per instance; the point is FORCED
// heterogeneity: quiet-but-expensive, kid-great-but-loud, cheap-but-stairs…
const TEMPLATES = [
  { key: "tea", names: ["Tea Ceremony", "Private Tea Gathering", "Machiya Tea Experience"], cats: ["tea", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: false, stairs: true, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [4, 5], tourist: [1, 3], langs: ["en", "ja"], food: true, veg: true, alcohol: false, dur: [60, 90], price: [4500, 15000], frictions: ["tatami seating — kneeling optional", "shoes off at the door", "advance booking essential"], desc: "A hushed tatami room, charcoal-heated kettle, and a host who explains each gesture as they make matcha for you." },
  { key: "wagashi", names: ["Wagashi Making Workshop", "Seasonal Sweets Class"], cats: ["food", "craft", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [2, 3], crowd: [3, 4], culture: [3, 4], tourist: [2, 4], langs: ["en", "ja"], food: true, veg: true, alcohol: false, dur: [75, 105], price: [3500, 7000], frictions: ["shared tables with other groups", "sugar-heavy — not a meal"], desc: "Shape nerikiri sweets beside a cheerful crowd of first-timers; you eat what you make with whisked matcha." },
  { key: "pottery", names: ["Pottery Wheel Session", "Ceramics Studio Intro"], cats: ["craft"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 6, wheelchair: false, stairs: true, intensity: 2, quiet: [3, 4], crowd: [2, 3], culture: [3, 4], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [5500, 9000], frictions: ["fired pieces ship in ~6 weeks", "clothes will get clay on them"], desc: "An hour at the wheel in a working studio; your piece is glazed, fired, and shipped to you afterwards." },
  { key: "kintsugi", names: ["Kintsugi Repair Atelier", "Gold-Joinery Class"], cats: ["craft", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 12, wheelchair: false, stairs: true, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [5, 5], tourist: [1, 2], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [120, 150], price: [9000, 16000], frictions: ["uses real urushi lacquer — skin sensitivity possible", "minimum age 12", "precision work"], desc: "Mend a broken bowl with lacquer and gold powder under a restorer's eye — the philosophy is the point." },
  { key: "indigo", names: ["Indigo Dyeing Studio", "Aizome Workshop"], cats: ["craft", "culture"], indoor: "indoor", rain: "good", heat: "okay", infant: false, stroller: true, minAge: 5, wheelchair: true, stairs: false, intensity: 2, quiet: [3, 4], crowd: [2, 3], culture: [4, 5], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [4000, 8000], frictions: ["dye stains — aprons provided but wear dark clothes", "hands stay faintly blue for a day"], desc: "Fold, clamp, and dip cloth in a living indigo vat; you leave with a tenugui you dyed yourself." },
  { key: "calligraphy", names: ["Calligraphy Lesson", "Shodo with a Master"], cats: ["culture", "craft"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [4, 5], tourist: [1, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [60, 90], price: [4000, 7500], frictions: ["ink is unforgiving on clothing", "seated focus for an hour"], desc: "Grind your own ink and work through strokes with a teacher who corrects your posture before your kanji." },
  { key: "sushi", names: ["Sushi Making Class", "Edomae Sushi Workshop"], cats: ["food"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [2, 3], crowd: [3, 4], culture: [3, 4], tourist: [3, 5], langs: ["en", "ja"], food: true, veg: true, alcohol: false, dur: [90, 120], price: [8000, 14000], frictions: ["raw fish handling", "popular — books out days ahead"], desc: "Roll, press, and eat your own nigiri with a chef translating the rice-to-fish ratios into plain English." },
  { key: "ramen", names: ["Back-street Ramen Tour", "Shoyu Ramen Crawl"], cats: ["food", "tour"], indoor: "mixed", rain: "okay", heat: "okay", infant: false, stroller: false, minAge: 8, wheelchair: false, stairs: true, intensity: 3, quiet: [1, 2], crowd: [4, 5], culture: [3, 4], tourist: [2, 4], langs: ["en"], food: true, veg: false, alcohol: false, dur: [150, 180], price: [9000, 13000], frictions: ["three bowls is a lot of food", "counter stools, no strollers", "walking between shops in any weather"], desc: "Three tiny counters, three regional styles, one guide who knows every master by first name." },
  { key: "sake", names: ["Sake Tasting Session", "Izakaya Sake Pairing"], cats: ["food", "drink"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 20, wheelchair: true, stairs: false, intensity: 1, quiet: [2, 4], crowd: [2, 4], culture: [3, 4], tourist: [2, 3], langs: ["en", "ja"], food: true, veg: true, alcohol: true, dur: [90, 120], price: [6500, 12000], frictions: ["strictly 20+ (Japanese drinking age)", "evening slots only some days"], desc: "Six pours from small breweries, told as stories — rice, water, and the towns they come from." },
  { key: "taiko", names: ["Taiko Drumming Intro", "Ensemble Drum Session"], cats: ["culture", "music"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 4, quiet: [1, 1], crowd: [3, 4], culture: [4, 4], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [60, 90], price: [5000, 8500], frictions: ["VERY loud — ear protection provided, still intense for babies", "physically demanding"], desc: "Full-body drumming that leaves your arms buzzing; kids grin through the entire hour." },
  { key: "zazen", names: ["Zazen Meditation Sitting", "Temple Morning Zazen"], cats: ["wellness", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 10, wheelchair: false, stairs: true, intensity: 1, quiet: [5, 5], crowd: [1, 2], culture: [5, 5], tourist: [1, 2], langs: ["ja"], food: false, veg: null, alcohol: false, dur: [60, 90], price: [1500, 4000], frictions: ["Japanese-only instruction", "strict silence — not for restless children", "cross-legged sitting on cushions"], desc: "Forty minutes of guided stillness in a working temple hall, then tea with the priest." },
  { key: "garden", names: ["Landscape Garden Walk", "Strolling Garden Visit"], cats: ["nature", "walk"], indoor: "outdoor", rain: "bad", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [4, 5], crowd: [2, 3], culture: [4, 4], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [60, 90], price: [300, 1200], frictions: ["gravel paths get muddy in rain", "little shelter if weather turns"], desc: "A stroll garden built for exactly this — turning a corner and being ambushed by a composed view." },
  { key: "cycling", names: ["Riverside Cycling Tour", "Backstreet Bike Tour"], cats: ["tour", "active"], indoor: "outdoor", rain: "cancelled", heat: "bad", infant: false, stroller: false, minAge: 12, wheelchair: false, stairs: false, intensity: 4, quiet: [2, 3], crowd: [2, 3], culture: [3, 3], tourist: [2, 3], langs: ["en"], food: false, veg: null, alcohol: false, dur: [180, 210], price: [8000, 11000], frictions: ["cancelled outright in rain", "12+ and confident riders only", "3+ hours of pedalling"], desc: "Fifteen unhurried kilometres along the river and through shitamachi lanes no bus can enter." },
  { key: "cruise", names: ["River Cruise", "Canal Boat Ride"], cats: ["tour", "nature"], indoor: "mixed", rain: "bad", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [3, 4], crowd: [3, 4], culture: [2, 3], tourist: [4, 5], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [45, 70], price: [1500, 3500], frictions: ["open deck is the whole point — grim in rain", "fixed departure times"], desc: "The city from water level, bridges counted off one by one by a recorded guide." },
  { key: "museum", names: ["Craft Museum Visit", "Small Museum & Archive"], cats: ["museum", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 5], crowd: [1, 3], culture: [4, 5], tourist: [1, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [60, 100], price: [800, 2000], frictions: ["captions partly Japanese-only", "closed some weekdays"], desc: "Two floors of one obsession — the kind of museum where the curator is at the desk and delighted you came." },
  { key: "sento", names: ["Retro Sento Bathhouse Visit", "Neighbourhood Onsen Sento"], cats: ["wellness", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 6, wheelchair: false, stairs: true, intensity: 1, quiet: [3, 4], crowd: [2, 3], culture: [4, 4], tourist: [1, 2], langs: ["ja"], food: false, veg: null, alcohol: false, dur: [60, 90], price: [550, 1200], frictions: ["tattoo policies vary by house", "nudity — communal bathing etiquette", "Japanese-only signage"], desc: "A 1950s bathhouse with a painted Fuji, kept alive by the same family for three generations." },
  { key: "kimono", names: ["Kimono Fitting & Stroll", "Kimono Photo Walk"], cats: ["culture", "tour"], indoor: "mixed", rain: "okay", heat: "bad", infant: false, stroller: false, minAge: 8, wheelchair: false, stairs: true, intensity: 2, quiet: [2, 3], crowd: [4, 5], culture: [2, 3], tourist: [5, 5], langs: ["en", "zh", "ja"], food: false, veg: null, alcohol: false, dur: [120, 180], price: [6000, 12000], frictions: ["very touristy photo spots", "layered kimono is punishing in heat", "return deadline for the garments"], desc: "Fitted, folded, and set loose on the old streets — expect to be photographed as much as you photograph." },
  { key: "market", names: ["Depachika Food Hall Tour", "Market Tasting Walk"], cats: ["food", "tour"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [1, 2], crowd: [5, 5], culture: [3, 4], tourist: [3, 4], langs: ["en"], food: true, veg: true, alcohol: false, dur: [90, 120], price: [7000, 10000], frictions: ["densely crowded aisles — strollers genuinely difficult", "constant noise"], desc: "The basement food floors decoded — what to taste, what to queue for, and what's only good today." },
  { key: "jazz", names: ["Jazz Kissa Evening", "Vinyl Listening Bar"], cats: ["music", "evening"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 18, wheelchair: false, stairs: true, intensity: 1, quiet: [3, 4], crowd: [2, 3], culture: [3, 4], tourist: [1, 2], langs: ["ja"], food: false, veg: null, alcohol: true, dur: [90, 150], price: [2500, 5000], frictions: ["18+ evening room", "talking discouraged while records play", "steep stairs, tiny basement"], desc: "A basement shrine to horn sections: one record side at a time, at volume, in respectful silence." },
  { key: "origami", names: ["Origami Masterclass", "Paper Folding Salon"], cats: ["craft"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [3, 4], crowd: [2, 3], culture: [3, 4], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [60, 90], price: [2500, 5000], frictions: ["fiddly for very small hands (parents fold, babies watch)"], desc: "From crane to something you didn't think paper could do, with a folder who competes internationally." },
  { key: "ikebana", names: ["Ikebana Flower Class", "Seasonal Arrangement Studio"], cats: ["craft", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: true, minAge: 8, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [4, 5], tourist: [1, 2], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [6000, 10000], frictions: ["sharp shears — 8 and up", "arrangement is awkward to carry onward"], desc: "Three stems, one bowl, and a teacher who removes half of what you add until it suddenly works." },
  { key: "knife", names: ["Knife Sharpening Lesson", "Blade Finishing Atelier"], cats: ["craft"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 16, wheelchair: false, stairs: true, intensity: 2, quiet: [3, 4], crowd: [1, 2], culture: [4, 4], tourist: [1, 2], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [11000, 18000], frictions: ["16+ (working blades)", "premium pricing", "your knife travels home in checked luggage only"], desc: "Whetstones, burrs, and a craftsman's hands over yours until the edge whispers through paper." },
  { key: "ghost", names: ["Twilight Alley Walk", "Old-Tokyo Night Stories"], cats: ["tour", "evening", "walk"], indoor: "outdoor", rain: "okay", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [3, 4], crowd: [1, 2], culture: [4, 4], tourist: [1, 2], langs: ["en"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [4000, 6500], frictions: ["evening only — starts after 19:00", "umbrella walking if drizzly"], desc: "Lantern-lit backstreets and the stories estate agents won't tell you, told slowly, after dark." },
  { key: "mochi", names: ["Mochi Pounding Party", "Rice Cake Workshop"], cats: ["food", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 3, quiet: [1, 2], crowd: [4, 5], culture: [3, 4], tourist: [3, 4], langs: ["en", "ja"], food: true, veg: true, alcohol: false, dur: [60, 90], price: [3500, 6000], frictions: ["loud, chanting, mallets — gloriously chaotic", "sticky everything"], desc: "Heave the mallet, chant with strangers, and eat mochi so fresh it barely holds its shape." },
  { key: "bonsai", names: ["Bonsai Styling Session", "Small Trees Atelier"], cats: ["craft", "nature"], indoor: "mixed", rain: "okay", heat: "okay", infant: false, stroller: true, minAge: 10, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [4, 5], tourist: [1, 2], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [7000, 13000], frictions: ["your tree cannot fly home with you (they ship domestically only)", "outdoor bench section"], desc: "Wire, clip, and argue gently with a forty-year-old tree under a master's supervision." },
  { key: "planetarium", names: ["Planetarium Show", "Star Theatre Session"], cats: ["indoor", "family"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 4], crowd: [3, 4], culture: [1, 2], tourist: [3, 4], langs: ["ja"], food: false, veg: null, alcohol: false, dur: [45, 60], price: [1500, 2800], frictions: ["Japanese narration only", "fixed showtimes", "dark room — some babies protest"], desc: "Reclined seats, a purring projector, and forty minutes of sky you cannot see from this city." },
  { key: "digital", names: ["Immersive Digital Art Museum", "Light Installation Galleries"], cats: ["museum", "family"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [1, 2], crowd: [5, 5], culture: [2, 2], tourist: [5, 5], langs: ["en", "zh", "ko", "ja"], food: false, veg: null, alcohol: false, dur: [90, 150], price: [3800, 4800], frictions: ["extremely crowded, timed entry sells out", "sensory overload — loud and flashing", "strollers must be checked at the door"], desc: "Rooms of light that swallow you whole; the whole internet has been here and it is still worth it." },
  { key: "cooking", names: ["Home-style Cooking Class", "Izakaya Cooking Workshop", "Bento Making Class"], cats: ["food", "cooking"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [2, 3], crowd: [2, 4], culture: [3, 4], tourist: [2, 3], langs: ["en", "ja"], food: true, veg: true, alcohol: false, dur: [120, 150], price: [7000, 12000], frictions: ["knives and open flames — supervision needed with kids", "you eat what you cook, good or not"], desc: "Shop-taught knife skills, a rolled omelette that finally works, and lunch you made yourself." },
  { key: "coffee", names: ["Kissaten Coffee Course", "Hand-drip Roastery Session"], cats: ["food", "coffee"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [3, 4], tourist: [1, 2], langs: ["en", "ja"], food: true, veg: true, alcohol: false, dur: [60, 90], price: [3000, 6000], frictions: ["caffeine, obviously", "counter seats only at some roasters"], desc: "Siphons, cloth filters, and a roaster who treats a bean like a vintage — third-wave before it had a name." },
  { key: "photo", names: ["Street Photography Walk", "Golden-hour Photo Tour"], cats: ["photography", "tour", "walk"], indoor: "outdoor", rain: "bad", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [3, 4], crowd: [2, 3], culture: [3, 4], tourist: [2, 3], langs: ["en"], food: false, veg: null, alcohol: false, dur: [120, 150], price: [8000, 12000], frictions: ["light rain kills the session", "bring your own camera or phone"], desc: "Two hours of alleys, reflections, and a pro nudging your framing until the city starts posing for you." },
  { key: "architecture", names: ["Modern Architecture Walk", "Metabolism Buildings Tour"], cats: ["architecture", "tour", "walk"], indoor: "mixed", rain: "okay", heat: "bad", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 3, quiet: [3, 4], crowd: [2, 3], culture: [4, 5], tourist: [1, 2], langs: ["en"], food: false, veg: null, alcohol: false, dur: [150, 180], price: [6500, 9500], frictions: ["three hours on foot", "summer heat is brutal between buildings"], desc: "Concrete visions of the future from 1970, read building by building by an architect who loves them." },
  { key: "gallery", names: ["Small Galleries Crawl", "Contemporary Art Circuit"], cats: ["galleries", "culture"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [4, 5], crowd: [1, 2], culture: [4, 5], tourist: [1, 2], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [2000, 5000], frictions: ["some galleries closed between shows"], desc: "Four white cubes in walking distance, one dealer's gossip, and art you can actually afford to covet." },
  { key: "livemusic", names: ["Live House Gig Night", "Underground Music Evening"], cats: ["music", "evening"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 18, wheelchair: false, stairs: true, intensity: 2, quiet: [1, 1], crowd: [4, 5], culture: [3, 4], tourist: [1, 2], langs: ["ja"], food: false, veg: null, alcohol: true, dur: [150, 180], price: [3500, 6000], frictions: ["18+, loud, standing room", "one drink minimum"], desc: "A basement the size of a living room, a band a month from breaking, and a crowd that knows every word." },
  { key: "theater", names: ["Small Theatre Performance", "Kagura Evening Show"], cats: ["theater", "culture", "evening"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 6, wheelchair: true, stairs: false, intensity: 1, quiet: [4, 4], crowd: [3, 4], culture: [4, 5], tourist: [2, 3], langs: ["ja"], food: false, veg: null, alcohol: false, dur: [90, 150], price: [3000, 8000], frictions: ["Japanese-language performance", "fixed curtain time"], desc: "Masks, drums, and a story older than the city, played to a hundred seats." },
  { key: "comedy", names: ["Rakugo in English", "Comedy Storytelling Night"], cats: ["comedy", "culture", "evening"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 10, wheelchair: true, stairs: false, intensity: 1, quiet: [3, 4], crowd: [3, 4], culture: [4, 4], tourist: [2, 3], langs: ["en"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [3500, 6000], frictions: ["evening shows only", "a fan and a hand towel are the entire set"], desc: "One kneeling storyteller, forty voices, zero props wasted — rakugo translated without losing the timing." },
  { key: "sumo", names: ["Sumo Morning Practice Visit", "Stable Keiko Viewing"], cats: ["sumo", "culture"], indoor: "indoor", rain: "good", heat: "okay", infant: false, stroller: false, minAge: 8, wheelchair: false, stairs: false, intensity: 1, quiet: [4, 5], crowd: [1, 2], culture: [5, 5], tourist: [2, 3], langs: ["ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [8000, 12000], frictions: ["strict silence and floor seating", "very early start", "no flash, no pointing feet"], desc: "The slap of flesh at 8 a.m., salt in the air, and etiquette that matters more than your camera." },
  { key: "martial", names: ["Aikido Taster Session", "Kendo Experience Class"], cats: ["martial arts", "active"], indoor: "indoor", rain: "good", heat: "okay", infant: false, stroller: false, minAge: 8, wheelchair: false, stairs: false, intensity: 4, quiet: [2, 3], crowd: [2, 3], culture: [4, 4], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 120], price: [6000, 9000], frictions: ["physically demanding", "bare feet on tatami, bruises possible"], desc: "Bow in, learn to fall, and swing a shinai until your wrists understand the point." },
  { key: "spa", names: ["Onsen Spa Afternoon", "Head Spa & Massage Session"], cats: ["wellness", "spa"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 13, wheelchair: true, stairs: false, intensity: 1, quiet: [5, 5], crowd: [1, 2], culture: [2, 3], tourist: [2, 3], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [90, 150], price: [8000, 16000], frictions: ["13+ quiet floors", "book well ahead — small treatment rooms"], desc: "Ninety minutes where nobody needs anything from you, ending with tea you drink horizontally." },
  { key: "boat", names: ["Evening Yakatabune Cruise", "Harbour Sunset Boat"], cats: ["boats", "evening", "tour"], indoor: "mixed", rain: "bad", heat: "okay", infant: true, stroller: false, minAge: 0, wheelchair: false, stairs: true, intensity: 1, quiet: [2, 3], crowd: [3, 4], culture: [3, 3], tourist: [3, 4], langs: ["ja"], food: true, veg: false, alcohol: true, dur: [120, 150], price: [9000, 14000], frictions: ["open deck grim in rain", "fixed departure — miss it and it is gone"], desc: "Lantern light on the water, tempura on the table, and the skyline doing its slow parade." },
  { key: "market", names: ["Morning Market Walk", "Shotengai Shopping-street Tour"], cats: ["markets", "food", "walk"], indoor: "mixed", rain: "okay", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [1, 2], crowd: [4, 5], culture: [3, 4], tourist: [2, 3], langs: ["en"], food: true, veg: true, alcohol: false, dur: [90, 120], price: [4000, 7000], frictions: ["crowded aisles, elbows out", "samples are breakfast"], desc: "A covered arcade of pickle barrels, knife shops, and grandmothers who run the place." },
  { key: "anime", names: ["Retro Game Center Crawl", "Anime District Deep Dive"], cats: ["anime / gaming", "tour"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 6, wheelchair: false, stairs: true, intensity: 2, quiet: [1, 1], crowd: [4, 5], culture: [2, 3], tourist: [3, 5], langs: ["en"], food: false, veg: null, alcohol: false, dur: [120, 150], price: [5000, 8000], frictions: ["sensory overload — flashing lights and noise", "coins disappear fast"], desc: "Four floors of CRT glow and rhythm games, guided by someone who can actually clear them." },
  { key: "maker", names: ["Leather Craft Workshop", "Neon-sign Making Studio", "Tin Toy Workshop"], cats: ["maker workshops", "craft"], indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: true, minAge: 10, wheelchair: true, stairs: false, intensity: 2, quiet: [3, 4], crowd: [1, 2], culture: [3, 3], tourist: [1, 2], langs: ["en", "ja"], food: false, veg: null, alcohol: false, dur: [120, 150], price: [8000, 15000], frictions: ["tools that bite — 10 and up", "your piece needs a day to cure sometimes"], desc: "A workbench, real tools, and a maker who lets you do the dangerous parts properly." },
  { key: "playground", names: ["Indoor Adventure Playground", "Children's Discovery Museum"], cats: ["family activities", "playground / child experiences"], indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 3, quiet: [1, 2], crowd: [4, 5], culture: [1, 2], tourist: [2, 3], langs: ["ja"], food: false, veg: null, alcohol: false, dur: [90, 150], price: [1500, 3500], frictions: ["gloriously loud", "socks required, adults crawl too"], desc: "Ball pits, air cannons, and a nap guaranteed afterwards — theirs, possibly yours." },
  { key: "seasonal", names: ["Summer Evening Festival Visit", "Seasonal Illumination Walk"], cats: ["seasonal events", "evening", "walk"], indoor: "outdoor", rain: "bad", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: [2, 3], crowd: [4, 5], culture: [3, 4], tourist: [3, 4], langs: ["ja"], food: true, veg: true, alcohol: false, dur: [90, 150], price: [1000, 3000], frictions: ["rain thins it to a damp shuffle", "festival crowds are real crowds"], desc: "Yukata, shaved ice, goldfish scooping — the summer evening formula, unchanged for a century." },
];

function operatorName() {
  return `${pick(OPERATOR_PREFIX)} ${pick(OPERATOR_NAME)}`;
}
const span = (v) => (Array.isArray(v) ? int(v[0], v[1]) : v);
const round500 = (n) => Math.round(n / 500) * 500;

function makeActivity(id, t, area, variantTag) {
  const [areaName, travel, lat, lng] = area;
  const price = round500(int(t.price[0], t.price[1]));
  const duration = Math.round(span(t.dur) / 15) * 15;
  const availability = makeAvailability(t);
  const name = variantTag ? `${pick(t.names)} — ${variantTag}` : pick(t.names);
  return {
    id,
    name: `${name}`,
    operator: operatorName(),
    region: "Tokyo",
    area: areaName,
    lat: +(lat + (rnd() - 0.5) * 0.004).toFixed(6),
    lng: +(lng + (rnd() - 0.5) * 0.004).toFixed(6),
    categories: t.cats,
    description: t.desc,
    price: { adultJpy: price, childJpy: t.minAge === 0 ? round500(price * 0.5) : undefined, infantJpy: t.infant ? 0 : undefined },
    durationMinutes: duration,
    indoorOutdoor: t.indoor,
    weather: { rain: t.rain, heat: t.heat },
    family: {
      infantFriendly: t.infant,
      strollerFriendly: t.stroller,
      minAge: t.minAge > 0 ? t.minAge : undefined,
      changingTable: t.infant ? chance(0.6) : false,
    },
    accessibility: {
      wheelchairAccessible: t.wheelchair,
      stairs: t.stairs,
      physicalIntensity: span([t.intensity, t.intensity]),
    },
    atmosphere: {
      quiet: span(t.quiet),
      crowdLevel: span(t.crowd),
      culturalDepth: span(t.culture),
      touristiness: span(t.tourist),
    },
    languages: t.langs,
    food: t.food ? { involved: true, vegetarianFriendly: t.veg ?? undefined, allergySupport: chance(0.5) } : { involved: false },
    alcohol: t.alcohol,
    booking: {
      advanceMinutes: pick([0, 30, 60, 60, 120, 1440]),
      cancellable: chance(0.75),
    },
    availability,
    friction: [...t.frictions, ...(chance(0.22) ? ["cash only"] : [])],
    travelMinutes: travel,
    provenance: { type: "synthetic" },
  };
}

// Curated activities with stable IDs for the repeatable demo.
const HEROES = [
  { id: "a001", name: "Private Tea Ceremony in a Yanaka Machiya", operator: "House Suzume", area: "Yanaka", cats: ["tea", "culture"], desc: "A 90-minute private tea gathering in a century-old townhouse — one host, your party only, charcoal quietly ticking. Babies are welcome to doze on the tatami.", price: 6500, infantJpy: 0, dur: 90, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: false, stairs: false, intensity: 1, quiet: 5, crowd: 1, culture: 5, tourist: 1, langs: ["en", "ja"], food: true, veg: true, alcohol: false, slots: ["14:00", "16:00"], advance: 60, frictions: ["shoes off, tatami seating", "narrow entrance — strollers parked at the door"] },
  { id: "a002", name: "Wagashi Making Workshop", operator: "Kobo Tsubaki", area: "Asakusa", cats: ["food", "craft", "culture"], desc: "Shape three seasonal nerikiri sweets at a lively shared table, then eat them with matcha. Great with kids; the room runs cheerful and loud.", price: 4500, infantJpy: 0, dur: 90, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: 2, crowd: 4, culture: 4, tourist: 3, langs: ["en", "ja"], food: true, veg: true, alcohol: false, slots: ["13:30", "15:30"], advance: 30, frictions: ["shared tables — a happy racket", "sticky fingers guaranteed"] },
  { id: "a003", name: "Kintsugi Repair Atelier", operator: "Atelier Kaede", area: "Kagurazaka", cats: ["craft", "culture"], desc: "Repair a broken vessel with lacquer and gold in a silent six-seat studio. Precision work — and the quietest room in this catalogue.", price: 13000, dur: 120, indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 12, wheelchair: false, stairs: true, intensity: 1, quiet: 5, crowd: 1, culture: 5, tourist: 1, langs: ["en", "ja"], food: false, alcohol: false, slots: ["14:30"], advance: 120, frictions: ["minimum age 12 — urushi lacquer", "steep stairs to the studio"] },
  { id: "a004", name: "Sumida Riverside Cycling Tour", operator: "Guild Take", area: "Sumida", cats: ["tour", "active"], desc: "Fifteen easy kilometres along the river with a guide, ending at a standing coffee counter. Cancelled outright in rain.", price: 9500, dur: 180, indoor: "outdoor", rain: "cancelled", heat: "bad", infant: false, stroller: false, minAge: 12, wheelchair: false, stairs: false, intensity: 4, quiet: 3, crowd: 2, culture: 3, tourist: 2, langs: ["en"], food: false, alcohol: false, slots: ["14:00"], advance: 60, frictions: ["cancelled in rain", "12+ riders only"] },
  { id: "a005", name: "Kiyosumi Garden Stroll & Sketching", operator: "Salon Momiji", area: "Kiyosumi", cats: ["nature", "walk"], desc: "A guided slow loop of a stone-and-water stroll garden with paper and pencils provided. Lovely — and mostly shelterless.", price: 2500, infantJpy: 0, dur: 75, indoor: "outdoor", rain: "bad", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: 5, crowd: 2, culture: 4, tourist: 2, langs: ["en", "ja"], food: false, alcohol: false, slots: ["10:00", "14:30"], advance: 0, frictions: ["little shelter if weather turns"] },
  { id: "a006", name: "Taiko Drumming Family Session", operator: "Studio Fuji", area: "Ryogoku", cats: ["culture", "music"], desc: "An hour of full-body drumming that children adore. Ear protection provided; it is still gloriously, unavoidably loud.", price: 6000, infantJpy: 0, dur: 60, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 4, quiet: 1, crowd: 4, culture: 4, tourist: 2, langs: ["en", "ja"], food: false, alcohol: false, slots: ["14:00", "16:00"], advance: 30, frictions: ["VERY loud — even with ear protection"] },
  { id: "a007", name: "Sake Brewery Tasting Flight", operator: "House Kikyo", area: "Nihonbashi", cats: ["food", "drink"], desc: "Six small pours from family breweries with the stories behind each label. Strictly adults.", price: 8000, dur: 90, indoor: "indoor", rain: "good", heat: "good", infant: false, stroller: false, minAge: 20, wheelchair: true, stairs: false, intensity: 1, quiet: 3, crowd: 2, culture: 4, tourist: 2, langs: ["en", "ja"], food: true, veg: true, alcohol: true, slots: ["15:00", "17:00"], advance: 60, frictions: ["strictly 20+ — no infants or children admitted"] },
  { id: "a008", name: "Ukiyo-e Woodblock Printing Studio", operator: "Atelier Kiri", area: "Yanesen", cats: ["craft", "culture"], desc: "Print your own copy of a wave from hand-carved blocks, layer by layer, in a calm four-table studio a lane off the tourist route.", price: 7000, infantJpy: 0, dur: 90, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: false, stairs: false, intensity: 1, quiet: 4, crowd: 2, culture: 5, tourist: 2, langs: ["en", "ja"], food: false, alcohol: false, slots: ["13:00", "15:00"], advance: 60, frictions: ["ink on clothes is forever", "stroller parked at entrance"] },
  { id: "a009", name: "Depachika Food Hall Safari", operator: "Bureau Yuzu", area: "Ginza", cats: ["food", "tour"], desc: "Ninety minutes underground in the best food halls on earth — tastings included, elbows required.", price: 9000, dur: 90, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: 1, crowd: 5, culture: 3, tourist: 3, langs: ["en"], food: true, veg: true, alcohol: false, slots: ["11:00", "15:00"], advance: 30, frictions: ["dense crowds — babies in carriers, not strollers"] },
  { id: "a010", name: "Immersive Digital Art Galleries", operator: "Studio Ran", area: "Omotesando", cats: ["museum", "family"], desc: "Rooms of moving light that swallow you whole. Unforgettable, mobbed, and loud — the whole internet is in the queue with you.", price: 4500, infantJpy: 0, dur: 120, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: false, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: 1, crowd: 5, culture: 2, tourist: 5, langs: ["en", "zh", "ko", "ja"], food: false, alcohol: false, slots: ["14:30", "16:30"], advance: 1440, frictions: ["timed entry sells out a day ahead", "sensory overload"] },
  { id: "a011", name: "Evening Lantern Alley Walk", operator: "Guild Tsuru", area: "Kagurazaka", cats: ["tour", "evening", "walk"], desc: "Cobbled lanes, paper lanterns, and quiet stories after dark. Starts at 19:30 — after most dinners begin.", price: 5000, infantJpy: 0, dur: 90, indoor: "outdoor", rain: "okay", heat: "okay", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 2, quiet: 4, crowd: 2, culture: 4, tourist: 1, langs: ["en"], food: false, alcohol: false, slots: ["19:30"], advance: 60, frictions: ["evening only — conflicts with most dinner plans"] },
  { id: "a012", name: "Ozu Washi Paper-Making Workshop", operator: "Kobo Ume", area: "Nihonbashi", cats: ["craft", "culture"], desc: "Pull your own sheets of washi at a 350-year-old paper house, then emboss and dry them to take home the same day. Calm, bright workroom.", price: 5500, infantJpy: 0, dur: 75, indoor: "indoor", rain: "good", heat: "good", infant: true, stroller: true, minAge: 0, wheelchair: true, stairs: false, intensity: 1, quiet: 4, crowd: 2, culture: 5, tourist: 2, langs: ["en", "ja"], food: false, alcohol: false, slots: ["14:00", "16:00"], advance: 30, frictions: ["water trays — sleeves get wet"] },
];

function heroToActivity(h) {
  const area = AREAS.find((a) => a[0] === h.area) ?? AREAS[0];
  return {
    id: h.id,
    name: h.name,
    operator: h.operator,
    region: "Tokyo",
    area: h.area,
    lat: area[2],
    lng: area[3],
    categories: h.cats,
    description: h.desc,
    price: { adultJpy: h.price, childJpy: h.minAge === 0 ? Math.round(h.price / 2 / 500) * 500 : undefined, infantJpy: h.infantJpy },
    durationMinutes: h.dur,
    indoorOutdoor: h.indoor,
    weather: { rain: h.rain, heat: h.heat },
    family: { infantFriendly: h.infant, strollerFriendly: h.stroller, minAge: h.minAge > 0 ? h.minAge : undefined, changingTable: h.infant },
    accessibility: { wheelchairAccessible: h.wheelchair, stairs: h.stairs, physicalIntensity: h.intensity },
    atmosphere: { quiet: h.quiet, crowdLevel: h.crowd, culturalDepth: h.culture, touristiness: h.tourist },
    languages: h.langs,
    food: h.food ? { involved: true, vegetarianFriendly: h.veg ?? undefined, allergySupport: true } : { involved: false },
    alcohol: h.alcohol,
    booking: { advanceMinutes: h.advance, cancellable: true },
    availability: { kind: "daily", times: h.slots, soldOutRate: 0 },
    friction: h.frictions,
    travelMinutes: area[1],
    provenance: { type: "synthetic" },
  };
}

const activities = HEROES.map(heroToActivity);
let seq = HEROES.length + 1;
const VARIANTS = ["Morning Edition", "Small Group", "Twilight Session", "Master Class", "Neighbourhood Edition", "Family Edition", "Extended", "Introduction", "Studio Session", "Local Edition", "Off-hours", "Season Special", "Beginner Friendly"];

for (const t of TEMPLATES) {
  const copies = int(19, 22);
  for (let i = 0; i < copies; i++) {
    const id = `a${String(seq++).padStart(3, "0")}`;
    const area = pick(AREAS);
    const tag = chance(0.7) ? pick(VARIANTS) : null;
    activities.push(makeActivity(id, t, area, tag));
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "activities.json");
writeFileSync(out, JSON.stringify({ seed: SEED, generatedBy: "scripts/generate-catalogue.mjs", activities }, null, 1) + "\n");
console.log(`wrote ${activities.length} activities (${HEROES.length} curated heroes + generated) to src/data/activities.json`);
