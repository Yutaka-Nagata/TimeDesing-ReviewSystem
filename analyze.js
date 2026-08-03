// 期間分析ツール（メール送信もClaude API呼び出しもしない。生データを集計して表示するだけ）
//   node --env-file=.env analyze.js            直近14日
//   node --env-file=.env analyze.js 30         直近30日
//   node --env-file=.env analyze.js 2026-07-01 2026-07-31   期間指定

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = 'da0d7d64-124a-4f80-b8b0-a2a967a7296c';

const dayIndex = s => {
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};
const fromDay = i => new Date(i * 86400000).toISOString().split('T')[0];
const shift = (s, n) => fromDay(dayIndex(s) + n);
const abs = (d, t) => {
  const [h, mi] = t.split(':').map(Number);
  return dayIndex(d) * 1440 + h * 60 + mi;
};
const fmtAbs = a => {
  const di = Math.floor(a / 1440);
  const m = a - di * 1440;
  return {
    date: fromDay(di),
    time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
  };
};
const hm = m => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

const CATEGORIES = [
  ['睡眠', /睡眠|仮眠|昼寝/],
  ['学習', /勉強|開発|Rails|チュートリアル|大規模言語モデル|RAG|技術書|ワーク|講座|学習/],
  ['娯楽', /漫画読|ゲーム|スマホ|アニメ|映画|YouTube|W杯|動画/],
  ['漫画作業', /漫画キャプチャ|キャプチャ/],
  ['生活', /食事|シャワー|運動|買い物|掃除|洗濯|移動/],
  ['交流', /交流|飲み|面談|1on1|インターン|Zoom/],
];
const categorize = title => (CATEGORIES.find(([, re]) => re.test(title)) ?? ['その他'])[0];

const args = process.argv.slice(2);
const today = fromDay(Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000));
let [from, to] = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!from) {
  const days = Number(args[0]) || 14;
  to = shift(today, -1);
  from = shift(to, -(days - 1));
}
to ??= shift(today, -1);

const url = `${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${USER_ID}&date=gte.${shift(from, -1)}&date=lte.${shift(to, 1)}&select=date,start_time,title,estimated_minutes,memo&order=date.asc,start_time.asc`;
const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
if (!res.ok) throw new Error(`Supabase error: ${res.status} ${await res.text()}`);
const rows = await res.json();

// 睡眠ブロック（起床日基準で帰属）
const blocks = rows
  .filter(r => /睡眠|仮眠|昼寝/.test(r.title))
  .map(r => {
    const s = abs(r.date, r.start_time);
    return { s, e: s + r.estimated_minutes, min: r.estimated_minutes };
  })
  .sort((a, b) => a.s - b.s);

const dates = [];
for (let i = dayIndex(from); i <= dayIndex(to); i++) dates.push(fromDay(i));

console.log(`期間: ${from} 〜 ${to}（${dates.length}日）\n`);
console.log('日付         就寝           起床    睡眠     学習    娯楽  漫画作業  交流');
console.log('─'.repeat(78));

const totals = {};
const sleepMins = [];
const wakeMins = [];
const bedMins = [];

for (const d of dates) {
  const woke = blocks.filter(b => fmtAbs(b.e).date === d);
  const main = woke.reduce((a, b) => (!a || b.min > a.min ? b : a), null);
  const dayRows = rows.filter(r => r.date === d);
  const per = {};
  for (const r of dayRows) {
    const c = categorize(r.title);
    per[c] = (per[c] ?? 0) + r.estimated_minutes;
    totals[c] = (totals[c] ?? 0) + r.estimated_minutes;
  }

  let bed = '     ―      ', wake = '  ―  ', dur = '   ―  ';
  if (main) {
    const bs = fmtAbs(main.s), we = fmtAbs(main.e);
    bed = `${bs.date === d ? '当日' : '前日'} ${bs.time}`;
    wake = we.time;
    dur = hm(main.min).padStart(6);
    sleepMins.push(main.min);
    wakeMins.push(main.e % 1440);
    // 就寝時刻を「前日24時からのオフセット」に正規化（27:15 のような表現）
    bedMins.push(main.s % 1440 + (bs.date === d ? 1440 : 0));
  }
  const wd = '日月火水木金土'[new Date(d + 'T00:00:00Z').getUTCDay()];
  const col = c => (per[c] ? hm(per[c]).padStart(6) : '     ―');
  console.log(`${d}(${wd}) ${bed}  ${wake} ${dur} ${col('学習')} ${col('娯楽')} ${col('漫画作業')} ${col('交流')}`);
}

const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const clock = m => `${String(Math.floor(m / 60) % 48).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

console.log('\n─── サマリー ───');
console.log(`睡眠記録あり: ${sleepMins.length}/${dates.length}日`);
console.log(`平均睡眠: ${hm(avg(sleepMins))}　中央値: ${hm(median(sleepMins))}　最短: ${hm(Math.min(...sleepMins))}　最長: ${hm(Math.max(...sleepMins))}`);
// 就寝・起床は外れ値（昼寝・徹夜明け）に平均が引きずられるため中央値を主に見る
console.log(`就寝 中央値: ${clock(median(bedMins))}（24時超は25:00形式）／平均: ${clock(avg(bedMins))}`);
console.log(`起床 中央値: ${clock(median(wakeMins))}／平均: ${clock(avg(wakeMins))}`);
console.log(`起床が正午以降の日: ${wakeMins.filter(m => m >= 720).length}日 / 就寝が翌4時以降: ${bedMins.filter(m => m >= 1440 + 240).length}日`);

console.log('\n─── カテゴリ別合計（対象期間の日付に紐づくタスク）───');
for (const [c, m] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
  console.log(`${c.padEnd(6)} ${hm(m).padStart(7)}　1日平均 ${hm(Math.round(m / dates.length))}`);
}

const study = totals['学習'] ?? 0;
console.log(`\n学習ゼロの日: ${dates.filter(d => !rows.some(r => r.date === d && categorize(r.title) === '学習')).length}日`);
console.log(`学習が5時間以上の日: ${dates.filter(d => rows.filter(r => r.date === d && categorize(r.title) === '学習').reduce((a, r) => a + r.estimated_minutes, 0) >= 300).length}日`);
console.log(`学習合計 ${hm(study)} / 娯楽合計 ${hm(totals['娯楽'] ?? 0)} / 漫画作業合計 ${hm(totals['漫画作業'] ?? 0)}`);
